# whisper-verify.ps1 - prove a whisper.cpp install actually transcribes,
# using audio this machine synthesizes for itself. No human recording, no
# sample file in the repo, nothing to check in.
#
# Split out of get-whisper.ps1 so there is ONE implementation of the
# round-trip: the acquirer's final step, scripts\verify-whisper.ps1, and
# tests\test-whisper-verify.js all call these functions. Same split as
# whisper-assets.ps1 (the download choice) and ae-dialog-triage.ps1.
#
# Measured on this machine 2026-08-29 against b4938 / ggml-base.en, and
# every one of these breaks the obvious implementation:
#
#  1. SILENCE DOES NOT TRANSCRIBE AS NOTHING. Two seconds of digital
#     silence at 16 kHz comes back as " You" - not an empty string, not
#     [BLANK_AUDIO]. So a check that asserts "the transcript is non-empty"
#     passes on a WAV containing no speech at all, which is exactly the
#     failure a verification harness exists to catch. The assertion has to
#     be that the SPOKEN PHRASE is in there.
#  2. READING THE PIPES IN THE WRONG ORDER HANGS FOREVER. whisper-cli
#     writes ~6 KB to stderr (backend banner, and the full usage dump on
#     any argument error). StandardOutput.ReadToEnd() blocks until the
#     child exits, the child blocks trying to write into a full stderr
#     pipe, and neither ever moves. Measured: a five-minute wall-clock
#     timeout with both processes alive. Both streams are read
#     asynchronously here, and there is a hard timeout on top.
#  3. NON-16 kHz AUDIO IS FINE. The note this file replaces claimed
#     whisper "refuses anything but 16 kHz mono 16-bit". Measured against
#     this build it does not: a 44 100 Hz mono WAV (header checked -
#     really 44 100) transcribed correctly, exit 0. It resamples. The
#     synthesizer is still asked for 16 kHz because that is the model's
#     native rate and skipping a resample is free, but a caller handing
#     over comp audio at 48 kHz (Pass C) does not need to convert first.
#
# And one from the code being replaced rather than from the binary:
#
#  4. `-like "*$phrase*"` IS A WILDCARD MATCH, NOT A CONTAINS. A phrase
#     holding `[` builds a broken character class and never matches; a
#     phrase holding `*` matches almost anything and reports PASS for
#     audio that was never spoken. Test-AellPhraseHeard compares literal
#     text.

. (Join-Path $PSScriptRoot 'whisper-assets.ps1')

# Phrases the harness speaks when the caller names none. Three, not one:
# a single phrase cannot tell "the model transcribes" apart from "some
# fixed string comes back". Plain words on purpose - this proves the
# install runs, not that base.en is accurate.
#
# These three are MEASURED, not chosen for looking like test sentences.
# Every phrase here transcribed exactly, three runs, base.en on this
# machine. Two rejected candidates say what to avoid:
#
#   'pack my box with five dozen liquor jugs' -> 'hack my box with 5
#   dozen liquor jugs'.  TWO different traps in one line. base.en writes
#   NUMBERS AS DIGITS, so any phrase holding a spoken number can never
#   match text holding the word - keep numbers out rather than teaching
#   the comparison to spell them, which is a second thing to get wrong.
#   And the synthesizer's plosive 'p' in "pack" reliably comes back as
#   "hack": the verification phrase is a fixture, and a fixture the model
#   gets wrong tests nothing except itself.
$script:AellWhisperPhrases = @(
    'the quick brown fox jumps over the lazy dog',
    'after effects renders the composition',
    'export the timeline as a lossless master file'
)

function Get-AellWhisperRoot {
    <#
      Where get-whisper.ps1 installs to. Kept here so callers that only
      want to VERIFY do not have to dot-source the acquirer.
    #>
    return (Join-Path $env:APPDATA 'AE-Llama\vendor\whisper.cpp')
}

function Find-AellWhisperInstall {
    <#
      Locate the exe and a model under an install root.

      Returns an object with .Ok, and on failure .Reason saying what IS
      there - the grounded-error rule. It does NOT throw, because "not
      installed" is the normal state on a CI runner and on any machine
      that has not run the acquirer; the caller decides whether that is a
      skip or a failure.
    #>
    param(
        [string]$Root = '',
        # Bare size ('base.en'), 'ggml-base.en' or 'ggml-base.en.bin'.
        # Empty picks the smallest model present, so the check stays fast
        # on a machine holding several.
        [string]$Model = ''
    )

    if (-not $Root) { $Root = Get-AellWhisperRoot }
    $binDir    = Join-Path $Root 'bin'
    $modelsDir = Join-Path $Root 'models'

    $result = [pscustomobject]@{
        Ok = $false; Root = $Root; Cli = ''; Model = ''
        Models = @(); Reason = ''
    }

    if (-not (Test-Path $Root)) {
        $result.Reason = ("No whisper.cpp install at $Root. Run " +
                          "scripts\get-whisper.ps1 to acquire one.")
        return $result
    }

    # -Recurse because the archive nests everything under Release\, and
    # whisper-cli.exe (not main.exe, a deprecation shim) is the
    # transcriber. See whisper-assets.ps1 note 2.
    $cli = $null
    if (Test-Path $binDir) {
        $cli = Get-ChildItem -Path $binDir -Recurse -Filter $script:AellWhisperExe `
                             -ErrorAction SilentlyContinue | Select-Object -First 1
    }
    if (-not $cli) {
        $got = ''
        if (Test-Path $binDir) {
            $got = (@(Get-ChildItem -Path $binDir -Recurse -Filter '*.exe' `
                                    -ErrorAction SilentlyContinue |
                      ForEach-Object { $_.Name }) -join ', ')
        }
        if (-not $got) { $got = '(none)' }
        $result.Reason = ("$($script:AellWhisperExe) is not under $binDir. " +
                          "Executables there: $got")
        return $result
    }
    $result.Cli = $cli.FullName

    $bins = @()
    if (Test-Path $modelsDir) {
        $bins = @(Get-ChildItem -Path $modelsDir -Filter '*.bin' `
                                -ErrorAction SilentlyContinue)
    }
    $result.Models = @($bins | ForEach-Object { $_.Name })
    if ($bins.Count -eq 0) {
        $result.Reason = ("No ggml-*.bin model in $modelsDir. Run " +
                          "scripts\get-whisper.ps1 (the binary is " +
                          "installed; only the model is missing).")
        return $result
    }

    if ($Model) {
        $want = ($Model -replace '^ggml-', '') -replace '\.bin$', ''
        $hit = $bins | Where-Object { $_.Name -eq "ggml-$want.bin" } |
               Select-Object -First 1
        if (-not $hit) {
            $result.Reason = ("Model 'ggml-$want.bin' is not in $modelsDir. " +
                              "Present: " + ($result.Models -join ', '))
            return $result
        }
        $result.Model = $hit.FullName
    } else {
        # Smallest FILE, not smallest name: the sizes are the model sizes,
        # and picking by name would need the size table kept in sync.
        $result.Model = ($bins | Sort-Object Length | Select-Object -First 1).FullName
    }

    $result.Ok = $true
    return $result
}

function ConvertTo-AellWhisperText {
    <#
      Normalize whisper-cli output (or a phrase) down to comparable text.

      Run over BOTH sides of the comparison, so the period whisper adds to
      "...the lazy dog." cannot fail a match against the phrase that was
      spoken. Digits survive - stripping them, as the first version did,
      would turn "take 2" into "take".
    #>
    param([string]$Raw = '')

    if (-not $Raw) { return '' }
    # [00:00:00.000 --> 00:00:03.080] first, on its own rule, so a test can
    # prove timestamps specifically are gone.
    $t = [regex]::Replace($Raw,
        '\[\s*\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\s*\]', ' ')
    # Then any other bracketed marker: [BLANK_AUDIO], [MUSIC], [_TT_ ...].
    $t = [regex]::Replace($t, '\[[^\]]*\]', ' ')
    $t = $t.ToLower()
    $t = [regex]::Replace($t, '[^a-z0-9 ]', ' ')
    $t = [regex]::Replace($t, '\s+', ' ')
    return $t.Trim()
}

function Test-AellPhraseHeard {
    <#
      Did the transcript contain the phrase? Literal containment on the
      normalized text - NOT -like, which would read `[` and `*` in the
      phrase as wildcard syntax. See note 4 at the top.
    #>
    param([string]$Heard = '', [string]$Phrase = '')

    $h = ConvertTo-AellWhisperText $Heard
    $p = ConvertTo-AellWhisperText $Phrase
    if (-not $p) { return $false }
    return $h.Contains($p)
}

function New-AellSpokenWav {
    <#
      Speak a phrase into a WAV with the OS synthesizer. This is what
      makes the check runnable unattended: no recording to ship, no
      microphone, nothing to license.

      16 kHz mono 16-bit is the model's native format (note 3: other
      rates work, this one just skips a resample). The synthesizer's own
      default is 22 050 stereo, so the format is always passed in.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Phrase,
        [Parameter(Mandatory = $true)][string]$Path,
        [int]$SampleRate = 16000
    )

    Add-Type -AssemblyName System.Speech
    $tts = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
        $voices = @($tts.GetInstalledVoices() | Where-Object { $_.Enabled })
        if ($voices.Count -eq 0) {
            throw ('No enabled text-to-speech voice is installed, so the ' +
                   'check cannot synthesize audio. Windows normally ships ' +
                   'Microsoft David and Zira; add one under Settings > ' +
                   'Time & language > Speech.')
        }
        $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
            $SampleRate,
            [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
            [System.Speech.AudioFormat.AudioChannel]::Mono)
        $tts.SetOutputToWaveFile($Path, $fmt)
        $tts.Speak($Phrase)
        $tts.SetOutputToNull()
    } finally {
        $tts.Dispose()
    }
    if (-not (Test-Path $Path)) {
        throw "The synthesizer reported success but wrote no file at $Path."
    }
    return $Path
}

function Invoke-AellWhisperCli {
    <#
      Run whisper-cli on one WAV and return
      @{ ExitCode; Out; Err; Text; Ms; TimedOut }.

      Both pipes are drained asynchronously BEFORE waiting on the process.
      Doing it the obvious way - ReadToEnd() on stdout, then WaitForExit -
      deadlocks against whisper-cli's ~6 KB of stderr (note 2), and the
      symptom is a hang with no output at all, which reads like a slow
      model rather than a bug in the caller.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Cli,
        [Parameter(Mandatory = $true)][string]$Model,
        [Parameter(Mandatory = $true)][string]$Wav,
        # Off by default: the check compares words, and the normalizer
        # strips timestamps anyway. Pass C wants them on.
        [switch]$Timestamps,
        [int]$TimeoutMs = 120000
    )

    # NOT $args: that is an automatic variable, and writing to it in a
    # function is asking for a surprise.
    $cliArgs = @('-m', $Model, '-f', $Wav, '-np')
    if (-not $Timestamps) { $cliArgs += '-nt' }

    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $Cli
    $psi.Arguments = ($cliArgs | ForEach-Object {
        if ($_ -match '[\s"]') { '"' + $_ + '"' } else { $_ }
    }) -join ' '
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true

    $sw = [Diagnostics.Stopwatch]::StartNew()
    $p = [Diagnostics.Process]::Start($psi)
    $tOut = $p.StandardOutput.ReadToEndAsync()
    $tErr = $p.StandardError.ReadToEndAsync()
    $done = $p.WaitForExit($TimeoutMs)
    if (-not $done) {
        try { $p.Kill() } catch {}
        $sw.Stop()
        return [pscustomobject]@{
            ExitCode = -1; Out = ''; Err = ''; Text = ''
            Ms = $sw.ElapsedMilliseconds; TimedOut = $true
        }
    }
    $sw.Stop()
    return [pscustomobject]@{
        ExitCode = $p.ExitCode
        Out      = $tOut.Result
        Err      = $tErr.Result
        Text     = ConvertTo-AellWhisperText $tOut.Result
        Ms       = $sw.ElapsedMilliseconds
        TimedOut = $false
    }
}

function Get-AellWhisperCliError {
    <#
      Pull the useful line out of whisper-cli's stderr. On any argument
      problem it dumps its whole ~5 KB usage screen after one `error:`
      line, and relaying all of it buries the answer.
    #>
    param([string]$Err = '')

    $lines = @()
    foreach ($line in ($Err -split "`r?`n")) {
        if ($line -match '^\s*error:') { $lines += $line.Trim() }
    }
    if ($lines.Count -gt 0) { return ($lines -join ' / ') }
    # No error: line at all - fall back to the first non-banner line.
    foreach ($line in ($Err -split "`r?`n")) {
        $t = $line.Trim()
        if ($t -and $t -notmatch '^load_backend:' -and $t -notmatch '^usage:') {
            return $t
        }
    }
    return ''
}

function Invoke-AellWhisperCheck {
    <#
      One phrase, end to end: synthesize -> transcribe -> assert the
      phrase is in the transcript. Returns
      @{ Pass; Phrase; Heard; Ms; Error }.

      Never throws for a transcription result; a wrong transcript is a
      $false Pass with the text that came back, which is what the caller
      prints.
    #>
    param(
        [Parameter(Mandatory = $true)]$Install,
        [Parameter(Mandatory = $true)][string]$Phrase,
        [int]$TimeoutMs = 120000
    )

    $wav = Join-Path ([IO.Path]::GetTempPath()) (
        'ae-whisper-check-{0}-{1}.wav' -f $PID, ([IO.Path]::GetRandomFileName()))
    $out = [pscustomobject]@{
        Pass = $false; Phrase = $Phrase; Heard = ''; Ms = 0; Error = ''
    }
    try {
        New-AellSpokenWav -Phrase $Phrase -Path $wav | Out-Null
        $r = Invoke-AellWhisperCli -Cli $Install.Cli -Model $Install.Model `
                                   -Wav $wav -TimeoutMs $TimeoutMs
        $out.Ms = $r.Ms
        $out.Heard = $r.Text
        if ($r.TimedOut) {
            $out.Error = "whisper-cli did not finish within $TimeoutMs ms."
            return $out
        }
        if ($r.ExitCode -ne 0) {
            # stdout is EMPTY on failure - everything useful is on stderr.
            $out.Error = ("whisper-cli exited $($r.ExitCode): " +
                          (Get-AellWhisperCliError $r.Err))
            return $out
        }
        # The phrase, not "did anything come back": silence transcribes as
        # " You" on this build (note 1).
        if (Test-AellPhraseHeard -Heard $r.Text -Phrase $Phrase) {
            $out.Pass = $true
        } else {
            $out.Error = ('transcript does not contain the spoken phrase. ' +
                          "spoken: [$(ConvertTo-AellWhisperText $Phrase)] " +
                          "heard: [$($r.Text)]")
        }
        return $out
    } catch {
        $out.Error = $_.Exception.Message
        return $out
    } finally {
        Remove-Item -Force $wav -ErrorAction SilentlyContinue
    }
}

function Invoke-AellWhisperVerify {
    <#
      The whole harness: find the install, speak every phrase through it,
      report. Returns @{ Skipped; Reason; Passed; Total; Results }.

      Skipped is the CI answer - no install is not a failure.
    #>
    param(
        [string]$Root = '',
        [string]$Model = '',
        [string[]]$Phrases = @(),
        [int]$TimeoutMs = 120000
    )

    if (-not $Phrases -or $Phrases.Count -eq 0) {
        $Phrases = $script:AellWhisperPhrases
    }
    $install = Find-AellWhisperInstall -Root $Root -Model $Model
    if (-not $install.Ok) {
        return [pscustomobject]@{
            Skipped = $true; Reason = $install.Reason
            Passed = 0; Total = 0; Results = @(); Install = $install
        }
    }

    $results = @()
    $passed = 0
    foreach ($phrase in $Phrases) {
        $r = Invoke-AellWhisperCheck -Install $install -Phrase $phrase `
                                     -TimeoutMs $TimeoutMs
        if ($r.Pass) { $passed++ }
        $results += $r
    }

    # Negative control. Everything above only ever asks the comparison to
    # say YES, so a Test-AellPhraseHeard that returned $true unconditionally
    # - or a normalizer that reduced both sides to '' - would report a
    # perfect score on a broken install. This asks it to say NO: the
    # transcript of phrase 1 must NOT contain phrase 2. It costs no extra
    # transcription, it reuses text already heard.
    $ps = @($Phrases)
    if ($ps.Count -ge 2 -and $results.Count -ge 1 -and $results[0].Pass) {
        $control = [pscustomobject]@{
            Pass = $false; Ms = 0; Error = ''
            Phrase = ('control: "' + $ps[1] + '" must NOT be heard in the ' +
                      'recording of "' + $ps[0] + '"')
            Heard = $results[0].Heard
        }
        if (Test-AellPhraseHeard -Heard $results[0].Heard -Phrase $ps[1]) {
            $control.Error = ('the check says a phrase that was never spoken ' +
                              'IS in the transcript, so a passing score above ' +
                              "means nothing. heard: [$($results[0].Heard)]")
        } else {
            $control.Pass = $true
            $passed++
        }
        $results += $control
    }

    return [pscustomobject]@{
        Skipped = $false; Reason = ''
        Passed = $passed; Total = @($results).Count
        Results = $results; Install = $install
    }
}
