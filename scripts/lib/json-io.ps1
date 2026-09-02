# json-io.ps1 - write JSON that Node can actually read.
#
# THE BUG THIS EXISTS TO KILL (measured 2026-09-02, cost two 5-minute
# unattended runs that produced nothing at all):
#
#   Set-Content -Encoding UTF8      # Windows PowerShell 5.1
#
# emits a UTF-8 BOM. Node's fs.readFileSync(p, "utf8") hands that BOM
# back as a leading U+FEFF, and JSON.parse THROWS on it:
#
#   SyntaxError: Unexpected token  in JSON at position 0
#
# The probe's job file was written that way. The CEP claimer renamed the
# job to claim it, called JSON.parse, threw, and returned from a silent
# catch - so the job was consumed, nothing ran, and nothing was written.
# The run looked like "Premiere hung for 300 seconds".
#
# PowerShell 6+ defaults to BOM-less UTF-8 and would have hidden this
# forever on a dev box while breaking every user on 5.1.
#
# Both halves of the fix matter: this writes without a BOM, and the
# readers strip one anyway. A file format that only works when both ends
# agree is a file format with two chances to break.
#
# ASCII only, Windows PowerShell 5.1 (CLAUDE.md).

function Write-AellJson {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Object,
        [int]$Depth = 8
    )
    $json = $Object | ConvertTo-Json -Depth $Depth
    # UTF8Encoding($false) = no byte order mark. This is the whole point.
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $json, $enc)
}

function Read-AellJson {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path $Path)) { return $null }
    $text = [System.IO.File]::ReadAllText($Path)
    # Strip a BOM written by anything else, for the same reason.
    if ($text.Length -gt 0 -and [int]$text[0] -eq 65279) {
        $text = $text.Substring(1)
    }
    if (-not $text.Trim()) { return $null }
    return $text | ConvertFrom-Json
}
