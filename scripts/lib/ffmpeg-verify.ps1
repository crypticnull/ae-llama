# ffmpeg-verify.ps1 - prove an ffmpeg install actually encodes, using a
# clip the machine synthesizes for itself. No sample media in the repo,
# nothing to license, nothing to check in.
#
# Split out of get-ffmpeg.ps1 so there is ONE implementation of the round
# trip: the acquirer's final step, scripts\verify-ffmpeg.ps1 and
# tests\test-ffmpeg-acquire.js all call these functions. Same split as
# whisper-verify.ps1 / whisper-assets.ps1.
#
# Everything here is shaped by five things measured on this machine on
# 2026-08-30 (ffmpeg 8.1, gyan.dev GPL build), and every one of them
# breaks the obvious implementation:
#
#  1. AN EXIT CODE OF 0 DOES NOT MEAN IT WROTE ANYTHING. Handed an output
#     path that already exists, ffmpeg WITHOUT -y prints "File ... already
#     exists. Exiting." and "Error opening output file", writes nothing,
#     and EXITS 0. Measured twice, byte-for-byte identical file before and
#     after. So an exporter that trusts the exit code hands the user last
#     week's render as this week's. Real argument errors do return
#     non-zero (-22 for a bad filter, -2 for a missing input), which is
#     what makes the 0 so easy to believe.
#
#  2. WITHOUT -nostdin IT HANGS FOREVER. That same already-exists case is
#     an interactive "Overwrite? [y/N]" prompt on stdin. Measured: killed
#     at a 10 s timeout with the process alive and idle. Unattended, that
#     is a wedged pass with no output. Every invocation here passes
#     -nostdin, and -y is explicit rather than assumed.
#
#  3. A VALID FILE CAN CONTAIN NOTHING. `ffmpeg -t 0` writes a 262-byte
#     MP4 that is structurally perfect: ffprobe exits 0, prints valid
#     JSON, writes NOTHING to stderr, and scores probe_score 100 -- with
#     "nb_streams": 0 and an empty streams array. This is the ffmpeg
#     equivalent of whisper transcribing silence as "You": every layer of
#     the obvious check reports success. The only real check is reading
#     the stream back and comparing width, height and frame count to what
#     was asked for, which is what Test-AellFfmpegClip does.
#
#  4. ffprobe EXITS 0 ON A FILE WITH NO MATCHING STREAM. `-select_streams
#     v` against an audio-only file answers `{ "streams": [] }`, exit 0,
#     empty stderr -- same shape as note 3 from the other direction. It
#     DOES exit 1 on a zero-byte or non-media file, but it still prints
#     parseable JSON (`{ }`) while doing it, so "the JSON parsed" is not a
#     check either.
#
#  5. DURATIONS COME BACK AS STRINGS, AND AS FLOATS. "1.000000", not 1.
#     Compared numerically and with a tolerance here; an equality test
#     against the requested seconds is a coin flip on any duration that
#     is not a whole number of frames.
#
# And one about where the binary lives rather than what it does: this
# machine already had ffmpeg 8.1 on PATH at C:\Program Files\ffmpeg
# before the acquirer existed. Find-AellFfmpegInstall looks in the
# vendor folder first and then falls back to PATH, so a user who already
# has one is not made to download 140 MB of duplicate.

. (Join-Path $PSScriptRoot 'ffmpeg-assets.ps1')

function Get-AellFfmpegRoot {
  <#
    Where get-ffmpeg.ps1 installs to. Kept here so callers that only want
    to VERIFY do not have to dot-source the acquirer.
  #>
  return (Join-Path $env:APPDATA 'AE-Llama\vendor\ffmpeg')
}

function Invoke-AellFfmpegProcess {
  <#
    Run one of the ffmpeg binaries and return
    @{ ExitCode; Out; Err; Ms; TimedOut }.

    Both pipes are drained ASYNCHRONOUSLY before waiting on the process.
    ffmpeg writes its whole banner, stream mapping and progress meter to
    stderr -- kilobytes of it -- so the obvious ReadToEnd()-then-
    WaitForExit deadlocks exactly the way whisper-cli does: the parent
    blocks on stdout, the child blocks on a full stderr pipe, and neither
    moves. Same fix, same reason, spelled out again because the two
    libraries do not share code.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [string[]]$Arguments = @(),
    [int]$TimeoutMs = 120000
  )

  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  $psi.Arguments = ($Arguments | ForEach-Object {
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
      ExitCode = -1; Out = ''; Err = ''
      Ms = $sw.ElapsedMilliseconds; TimedOut = $true
    }
  }
  $sw.Stop()
  return [pscustomobject]@{
    ExitCode = $p.ExitCode
    Out      = $tOut.Result
    Err      = $tErr.Result
    Ms       = $sw.ElapsedMilliseconds
    TimedOut = $false
  }
}

function Find-AellFfmpegInstall {
  <#
    Locate ffmpeg.exe and ffprobe.exe.

    Order: the vendor folder this repo's acquirer writes, then PATH. The
    PATH fallback is not a convenience -- this machine had ffmpeg 8.1 in
    C:\Program Files\ffmpeg before any of this was written, and making a
    user download 140 MB they already have is the kind of thing they
    notice.

    Returns an object with .Ok, and on failure .Reason saying what IS
    there. It does NOT throw: "not installed" is the normal state on a CI
    runner and on any machine that has not run the acquirer, and the
    caller decides whether that is a skip or a failure.
  #>
  param(
    [string]$Root = '',
    # Skip the PATH fallback -- used by the tests to prove the
    # not-installed message, and by anyone who wants the vendored copy
    # specifically.
    [switch]$VendorOnly
  )

  if (-not $Root) { $Root = Get-AellFfmpegRoot }
  $binDir = Join-Path $Root 'bin'

  $result = [pscustomobject]@{
    Ok = $false; Root = $Root; Source = ''
    Ffmpeg = ''; Ffprobe = ''; Reason = ''
  }

  # -Recurse because the archive nests everything under
  # ffmpeg-<build>-win64-<lic>\bin\, the same way whisper's nests under
  # Release\. A non-recursive lookup finds nothing and reads as "the
  # download failed".
  $ff = $null; $fp = $null
  if (Test-Path $binDir) {
    $ff = Get-ChildItem -Path $binDir -Recurse -Filter $script:AellFfmpegExe `
                        -ErrorAction SilentlyContinue | Select-Object -First 1
    $fp = Get-ChildItem -Path $binDir -Recurse -Filter $script:AellFfprobeExe `
                        -ErrorAction SilentlyContinue | Select-Object -First 1
  }
  if ($ff -and $fp) {
    $result.Ok = $true; $result.Source = 'vendor'
    $result.Ffmpeg = $ff.FullName; $result.Ffprobe = $fp.FullName
    return $result
  }

  # A vendor folder holding one of the two is a half-install, and saying
  # so is more useful than falling through to PATH silently.
  $halfInstall = ''
  if ($ff -and -not $fp) {
    $halfInstall = ("$binDir has $($script:AellFfmpegExe) but no " +
                    "$($script:AellFfprobeExe). ")
  } elseif ($fp -and -not $ff) {
    $halfInstall = ("$binDir has $($script:AellFfprobeExe) but no " +
                    "$($script:AellFfmpegExe). ")
  }

  if (-not $VendorOnly) {
    $pff = Get-Command $script:AellFfmpegExe -ErrorAction SilentlyContinue
    $pfp = Get-Command $script:AellFfprobeExe -ErrorAction SilentlyContinue
    if ($pff -and $pfp) {
      $result.Ok = $true; $result.Source = 'path'
      $result.Ffmpeg = $pff.Source; $result.Ffprobe = $pfp.Source
      return $result
    }
  }

  $where = 'vendor or PATH'
  if ($VendorOnly) { $where = 'the vendor folder' }
  $result.Reason = ($halfInstall +
    "No ffmpeg install found in $where. Looked for " +
    "$($script:AellFfmpegExe) and $($script:AellFfprobeExe) under " +
    "$binDir. Run scripts\get-ffmpeg.ps1 to acquire one.")
  return $result
}

function Get-AellFfmpegVersion {
  <#
    The version string ffmpeg reports about ITSELF.

    Read from the binary rather than from the release tag on purpose:
    BtbN's newest tag is literally `latest`, a rolling tag republished on
    every autobuild, so it records nothing about what is on disk.
  #>
  param([Parameter(Mandatory = $true)][string]$Ffmpeg)

  $r = Invoke-AellFfmpegProcess -Exe $Ffmpeg `
                                -Arguments @('-hide_banner', '-nostdin', '-version') `
                                -TimeoutMs 20000
  if ($r.ExitCode -ne 0) { return '' }
  $first = (($r.Out -split "`n") | Select-Object -First 1)
  $m = [regex]::Match($first, '^ffmpeg version (\S+)')
  if ($m.Success) { return $m.Groups[1].Value }
  return $first.Trim()
}

function Get-AellFfmpegEncoders {
  <#
    Which of the encoders 6.2 Pass B cares about this build actually has.

    The licence choice (gpl vs lgpl) changes the codec set, so this is
    printed after every install: the consequence of the choice is
    measured on the binary, never assumed from the name.

    THIS IS A COMPILE-TIME LIST, NOT A RUNTIME ONE, and 6.2 Pass B must
    not treat it as a promise. Measured on this machine 2026-08-30
    against the LGPL n9.0 build: `-encoders` names h264_amf and
    h264_qsv, and BOTH fail at encode time here (exit -558323010 and
    -1313558101, zero bytes written) because there is no AMD or Intel
    device to run them on -- while libopenh264, h264_nvenc and h264_mf
    all produce real h264 in 37-190 ms. An exporter that picks the first
    name off this list gets a hard failure on the user's machine. Pick by
    trying, or default to the software encoder.

    `ffmpeg -encoders` prints a capability-flag column, then the encoder
    name, then a description -- "V....D libx264  libx264 H.264 ...". The
    name is matched as a WHOLE field between whitespace: a substring
    search for 'libx264' also matches libx264rgb, and one for 'h264_mf'
    matches nothing at all if the description happens to move.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$Ffmpeg,
    [string[]]$Names = @()
  )

  if (-not $Names -or $Names.Count -eq 0) {
    $Names = $script:AellFfmpegEncodersOfInterest
  }
  $r = Invoke-AellFfmpegProcess -Exe $Ffmpeg `
                                -Arguments @('-hide_banner', '-nostdin', '-encoders') `
                                -TimeoutMs 20000
  $text = $r.Out
  $out = [ordered]@{}
  foreach ($n in $Names) {
    $out[$n] = ($text -match ('(?m)^\s*\S+\s+' + [regex]::Escape($n) + '\s'))
  }
  return $out
}

function Test-AellFfmpegClip {
  <#
    Read a written clip back with ffprobe and say whether it is the clip
    that was asked for.

    This is the whole point of the file. See notes 3 and 4 at the top: a
    262-byte MP4 with zero streams passes "ffmpeg exited 0", "the file
    exists", "ffprobe exited 0" and "the JSON parsed". It fails HERE,
    because the width, height and frame count are read out of the stream
    and compared.

    One thing measured after the first version of this rejected a
    perfectly good VP9 file: MATROSKA-FAMILY CONTAINERS REPORT NEITHER
    nb_frames NOR duration ON THE STREAM. Both are simply absent for
    .webm and .mkv, while .mp4 and .gif carry both. Read naively that is
    "0 frames", so the checker called a real 10-frame clip a failure --
    the mirror image of the bug it exists to catch, and the one that
    would have made a future export_gif/export_social check unusable for
    half the formats it needs. So the frame count falls back to ffprobe's
    -count_frames (which decodes: measured at 25 ms for these clips, and
    correct for all four containers) and the duration falls back to the
    FORMAT's duration. Neither fallback loosens anything -- both produce
    the real number where the fast field was missing.

    Returns @{ Pass; Reason; Width; Height; Frames; Seconds; Codec;
    FrameSource }.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$Ffprobe,
    [Parameter(Mandatory = $true)][string]$Path,
    [int]$Width = 0,
    [int]$Height = 0,
    [int]$Frames = 0,
    [double]$Seconds = 0,
    # Durations are strings AND floats (note 5), and a container rounds
    # them to its own time base. Half a frame at 10 fps is plenty.
    [double]$Tolerance = 0.05
  )

  $res = [pscustomobject]@{
    Pass = $false; Reason = ''; Width = 0; Height = 0
    Frames = 0; Seconds = 0.0; Codec = ''; FrameSource = ''
  }

  if (-not (Test-Path $Path)) {
    $res.Reason = "ffmpeg reported success but wrote no file at $Path."
    return $res
  }
  $bytes = (Get-Item $Path).Length
  if ($bytes -eq 0) {
    $res.Reason = "ffmpeg wrote a zero-byte file at $Path."
    return $res
  }

  $r = Invoke-AellFfmpegProcess -Exe $Ffprobe -Arguments @(
    '-v', 'error', '-print_format', 'json',
    '-select_streams', 'v:0', '-show_streams', '-show_format', $Path
  ) -TimeoutMs 30000

  # Checked, but never trusted on its own: ffprobe exits 0 on a
  # stream-less file (note 3) and 1 on a non-media one while still
  # printing `{ }` (note 4).
  if ($r.ExitCode -ne 0) {
    $res.Reason = ("ffprobe exited $($r.ExitCode) on $Path " +
                   "($bytes bytes): " + $r.Err.Trim())
    return $res
  }

  $json = $null
  try { $json = ConvertFrom-Json $r.Out } catch {
    $res.Reason = "ffprobe did not return JSON for $Path : " + $r.Out
    return $res
  }
  $streams = @($json.streams)
  if ($streams.Count -eq 0) {
    $res.Reason = ("$Path has NO video stream. ffmpeg exited 0 and " +
                   "ffprobe exited 0; the file is $bytes bytes of valid " +
                   "container with nothing in it.")
    return $res
  }

  $s = $streams[0]
  $res.Width  = [int]$s.width
  $res.Height = [int]$s.height
  $res.Codec  = [string]$s.codec_name
  # nb_frames and duration are strings, and BOTH are absent on
  # matroska-family containers (.webm, .mkv). See the note above.
  if ($s.PSObject.Properties['nb_frames'] -and $s.nb_frames) {
    $res.Frames = [int]$s.nb_frames
    $res.FrameSource = 'nb_frames'
  } elseif ($Frames -gt 0) {
    # Only when the caller actually wants a count: this pass DECODES the
    # file, so it is not something to do on every probe.
    $rc = Invoke-AellFfmpegProcess -Exe $Ffprobe -Arguments @(
      '-v', 'error', '-print_format', 'json',
      '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=nb_read_frames', $Path
    ) -TimeoutMs 60000
    if ($rc.ExitCode -eq 0) {
      try {
        $jc = ConvertFrom-Json $rc.Out
        $cs = @($jc.streams)
        if ($cs.Count -gt 0 -and $cs[0].PSObject.Properties['nb_read_frames'] -and
            $cs[0].nb_read_frames) {
          $res.Frames = [int]$cs[0].nb_read_frames
          $res.FrameSource = 'count_frames'
        }
      } catch {}
    }
  }
  if ($s.PSObject.Properties['duration'] -and $s.duration) {
    $res.Seconds = [double]$s.duration
  } elseif ($json.PSObject.Properties['format'] -and $json.format -and
            $json.format.PSObject.Properties['duration'] -and
            $json.format.duration) {
    # The container knows even when the stream does not.
    $res.Seconds = [double]$json.format.duration
  }

  $bad = @()
  if ($Width  -gt 0 -and $res.Width  -ne $Width)  { $bad += "width $($res.Width) != $Width" }
  if ($Height -gt 0 -and $res.Height -ne $Height) { $bad += "height $($res.Height) != $Height" }
  if ($Frames -gt 0 -and $res.Frames -ne $Frames) {
    $src = $res.FrameSource
    if (-not $src) { $src = 'neither nb_frames nor a decode count' }
    $bad += "frames $($res.Frames) != $Frames (from $src)"
  }
  if ($Seconds -gt 0 -and [math]::Abs($res.Seconds - $Seconds) -gt $Tolerance) {
    $bad += "duration $($res.Seconds)s != $Seconds s (tolerance $Tolerance)"
  }
  if ($bad.Count -gt 0) {
    $res.Reason = "$Path is not the clip that was asked for: " + ($bad -join '; ')
    return $res
  }

  $res.Pass = $true
  return $res
}

function Invoke-AellFfmpegCheck {
  <#
    The round trip: synthesize a clip with ffmpeg, read it back with
    ffprobe, and assert it is the clip that was asked for.

    The source is lavfi `testsrc`, which every build has -- no input file,
    nothing to ship. The encoder is mpeg4 (MPEG-4 Part 2) for the same
    reason: it is native to ffmpeg, so this check runs identically on the
    LGPL build, which has no libx264 to fall back on. What each build can
    ENCODE is a separate question, answered by Get-AellFfmpegEncoders --
    conflating the two would make the check pass or fail for reasons that
    have nothing to do with whether the install works.

    Returns @{ Pass; Reason; Ms; Bytes; Probe; Version }.
  #>
  param(
    $Install,
    [int]$Width = 160,
    [int]$Height = 120,
    [int]$Fps = 10,
    [double]$Seconds = 1.0,
    [string]$WorkDir = ''
  )

  $res = [pscustomobject]@{
    Pass = $false; Reason = ''; Ms = 0; Bytes = 0
    Probe = $null; Version = ''
  }

  $tmp = $WorkDir
  $mine = $false
  if (-not $tmp) {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("ae-ffmpeg-check-" +
            [IO.Path]::GetRandomFileName())
    $mine = $true
  }
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null

  try {
    $out = Join-Path $tmp 'aell-check.mp4'
    $src = ("testsrc=size={0}x{1}:rate={2}:duration={3}" -f
            $Width, $Height, $Fps, $Seconds)
    # -nostdin and -y are both load-bearing, not tidiness: see notes 1
    # and 2 at the top of this file.
    $r = Invoke-AellFfmpegProcess -Exe $Install.Ffmpeg -Arguments @(
      '-hide_banner', '-nostdin', '-y',
      '-f', 'lavfi', '-i', $src,
      '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', $out
    ) -TimeoutMs 60000
    $res.Ms = $r.Ms

    if ($r.TimedOut) {
      $res.Reason = ('ffmpeg did not exit within 60s. If this build is a ' +
                     '-shared one, it may be waiting on a missing DLL.')
      return $res
    }
    if ($r.ExitCode -ne 0) {
      $res.Reason = ("ffmpeg exited $($r.ExitCode): " +
                     (($r.Err -split "`n") | Select-Object -Last 5 | Out-String).Trim())
      return $res
    }
    if (Test-Path $out) { $res.Bytes = (Get-Item $out).Length }

    $expectFrames = [int][math]::Round($Fps * $Seconds)
    $probe = Test-AellFfmpegClip -Ffprobe $Install.Ffprobe -Path $out `
                                 -Width $Width -Height $Height `
                                 -Frames $expectFrames -Seconds $Seconds
    $res.Probe = $probe
    if (-not $probe.Pass) { $res.Reason = $probe.Reason; return $res }

    $res.Version = Get-AellFfmpegVersion -Ffmpeg $Install.Ffmpeg
    $res.Pass = $true
    return $res
  } finally {
    if ($mine) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
  }
}

function Test-AellFfmpegCheckerRejectsEmpty {
  <#
    Prove the checker can FAIL.

    A verification harness that only ever runs the positive case tells you
    nothing: the version of Test-AellFfmpegClip that returns $true
    unconditionally passes every other check in this file. So this builds
    the exact artefact note 3 describes -- `ffmpeg -t 0`, which exits 0
    and writes a structurally valid MP4 with zero streams -- and asserts
    the checker REJECTS it.

    This is the ffmpeg version of "a whisper check that cannot pass on
    silence", and it is run as part of the standard verify rather than
    kept as a one-off probe, because the failure it guards against is a
    later edit to the checker rather than a bad install.

    Returns @{ Pass; Reason; Bytes; Rejection }.
  #>
  param($Install, [string]$WorkDir = '')

  $res = [pscustomobject]@{
    Pass = $false; Reason = ''; Bytes = 0; Rejection = ''
  }

  $tmp = $WorkDir
  $mine = $false
  if (-not $tmp) {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("ae-ffmpeg-neg-" +
            [IO.Path]::GetRandomFileName())
    $mine = $true
  }
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null

  try {
    $out = Join-Path $tmp 'aell-empty.mp4'
    $r = Invoke-AellFfmpegProcess -Exe $Install.Ffmpeg -Arguments @(
      '-hide_banner', '-nostdin', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1',
      '-t', '0', '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', $out
    ) -TimeoutMs 60000

    # ffmpeg is EXPECTED to succeed here. If it ever starts refusing to
    # write an empty file, the trap this guards is gone and the check
    # should be revisited rather than silently reported as passing.
    if ($r.ExitCode -ne 0) {
      $res.Reason = ("ffmpeg refused to write a zero-length clip " +
                     "(exit $($r.ExitCode)). The empty-output trap this " +
                     "check exists for may no longer reproduce on this " +
                     "build; re-measure before trusting it.")
      return $res
    }
    if (-not (Test-Path $out)) {
      $res.Reason = ('ffmpeg exited 0 for -t 0 and wrote no file at all, ' +
                     'so the zero-stream trap did not reproduce.')
      return $res
    }
    $res.Bytes = (Get-Item $out).Length

    $probe = Test-AellFfmpegClip -Ffprobe $Install.Ffprobe -Path $out `
                                 -Width 160 -Height 120 -Frames 10 -Seconds 1.0
    if ($probe.Pass) {
      $res.Reason = ("The checker ACCEPTED a $($res.Bytes)-byte file with " +
                     "no video stream. Test-AellFfmpegClip is not checking " +
                     "anything.")
      return $res
    }
    $res.Rejection = $probe.Reason
    $res.Pass = $true
    return $res
  } finally {
    if ($mine) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
  }
}

function Invoke-AellFfmpegVerify {
  <#
    The whole verification, as one call: find the install, run the
    positive round trip over several clip shapes, and run the negative
    self-check.

    Returns @{ Skipped; Reason; Install; Results; Passed; Total;
    Version; Encoders }. It does NOT throw on a missing install -- that
    is the normal state on a CI runner, and the caller decides whether it
    is a skip or a failure.
  #>
  param(
    [string]$Root = '',
    [switch]$VendorOnly,
    # More than one shape on purpose: a single fixed clip cannot tell
    # "ffmpeg encodes what it is asked for" apart from "some 160x120
    # file always comes back". Odd dimensions and a non-integer duration
    # are in here because both have their own rounding.
    $Clips = @(
      @{ Width = 160; Height = 120; Fps = 10; Seconds = 1.0 },
      @{ Width = 320; Height = 240; Fps = 25; Seconds = 0.6 },
      @{ Width = 64;  Height = 48;  Fps = 5;  Seconds = 2.0 }
    )
  )

  $out = [pscustomobject]@{
    Skipped = $false; Reason = ''; Install = $null
    Results = @(); Passed = 0; Total = 0; Version = ''; Encoders = $null
  }

  $install = Find-AellFfmpegInstall -Root $Root -VendorOnly:$VendorOnly
  if (-not $install.Ok) {
    $out.Skipped = $true; $out.Reason = $install.Reason
    return $out
  }
  $out.Install = $install

  $results = @()
  foreach ($c in @($Clips)) {
    $label = ("{0}x{1} @ {2}fps, {3}s" -f $c.Width, $c.Height, $c.Fps, $c.Seconds)
    $chk = Invoke-AellFfmpegCheck -Install $install -Width $c.Width `
                                  -Height $c.Height -Fps $c.Fps -Seconds $c.Seconds
    $results += [pscustomobject]@{
      Label = $label; Pass = $chk.Pass; Ms = $chk.Ms
      Error = $chk.Reason; Detail = ''
    }
    if ($chk.Pass -and -not $out.Version) { $out.Version = $chk.Version }
  }

  $neg = Test-AellFfmpegCheckerRejectsEmpty -Install $install
  $results += [pscustomobject]@{
    Label = 'the checker rejects a valid file with no video stream'
    Pass  = $neg.Pass; Ms = 0; Error = $neg.Reason
    Detail = $neg.Rejection
  }

  $out.Results = $results
  $out.Total = $results.Count
  $out.Passed = @($results | Where-Object { $_.Pass }).Count
  if (-not $out.Version) {
    $out.Version = Get-AellFfmpegVersion -Ffmpeg $install.Ffmpeg
  }
  $out.Encoders = Get-AellFfmpegEncoders -Ffmpeg $install.Ffmpeg
  return $out
}
