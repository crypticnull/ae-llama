# ae-crash-flag.ps1 -- read and clear After Effects' crash-recovery flag.
#
# Why this exists (WORKPLAN section 21).
#
# AE's crash-recovery prompt blocks the harness completely: AE never
# opens its main window, run-ae-selftest.ps1 times out after 240s, and
# the pass reports a code problem that does not exist. Measured
# 2026-09-08 on AE 26.3, that dialog cannot be pressed by automation at
# all. It is a #32770 with an empty title whose entire content is one
# OS_ViewContainer, and UI Automation over every descendant returns a
# single Pane: no button HWND, no UIA element, so every Buttons list in
# host-dialogs.ps1 is unreachable there.
#
# The watchdog rule meant to catch it could never match either. It keys
# on the word "recover"; the dialog says "We recommend starting a Safe
# Mode session".
#
# So the dialog cannot be ANSWERED. It has to be PREVENTED, by clearing
# the flag that arms it before AE is launched.
#
# The flag, measured 2026-09-08 against the live machine:
#
#     HKCU:\Software\Adobe\After Effects\<ProductVersion>\CrashOccurred
#
# a DWord. Version 26.2 carried CrashOccurred = 1 left over from an old
# crash; 26.3 carried no such value while running normally.
#
# <ProductVersion> is EXACTLY the registry subkey name: AfterFX.exe 26.3
# reports ProductVersion "26.3". The install path is "Adobe After
# Effects 2026", which is a different number entirely and must never be
# used for this mapping.
#
# The trap being closed is self-sustaining, which is why it is worth
# code rather than a note. The harness kills AE when it times out, and
# killing AE is precisely what arms the prompt for the next launch. Left
# alone it reproduces itself every pass, forever, and each night's log
# reads like a fresh problem.
#
# Answering it wrongly is worse than being blocked. The Safe Mode branch
# succeeds: AE launches, the harness runs, every step executes -- with
# scripts and extensions unloaded, so the panel is simply absent. That
# reads exactly like a bug in the panel, and sends the next pass hunting
# something that does not exist.

# No Set-StrictMode here on purpose: this file is DOT-SOURCED, so any
# mode it sets lands in the caller's scope and changes the semantics of
# code that never asked for it. Nothing else in scripts/ sets it either.

# Map an AfterFX.exe to its HKCU version key. Returns $null when the exe
# is missing or reports no usable version, so a caller can say WHY
# rather than clearing a key it guessed at.
function Get-AellAeVersionKey {
    param([Parameter(Mandatory = $true)][string]$ExePath)

    if (-not (Test-Path -LiteralPath $ExePath)) { return $null }
    $pv = $null
    try { $pv = (Get-Item -LiteralPath $ExePath).VersionInfo.ProductVersion } catch { return $null }
    if (-not $pv) { return $null }

    $parts = ($pv.Trim() -split '\.')
    if ($parts.Count -lt 2) { return $null }
    return ('HKCU:\Software\Adobe\After Effects\' + $parts[0] + '.' + $parts[1])
}

# Read the flag. Returns $null when the key or the value is absent --
# which is the NORMAL state for a healthy install, and is not the same
# as 0. A caller that cannot tell those apart cannot report honestly.
function Get-AellAeCrashFlag {
    param([Parameter(Mandatory = $true)][string]$VersionKey)

    if (-not (Test-Path -LiteralPath $VersionKey)) { return $null }
    $item = Get-ItemProperty -LiteralPath $VersionKey -ErrorAction SilentlyContinue
    if ($null -eq $item) { return $null }
    if ($null -eq $item.PSObject.Properties['CrashOccurred']) { return $null }
    return [int]$item.CrashOccurred
}

# Is any After Effects running right now? AE owns this registry key for
# the life of its session and rewrites it on exit.
function Test-AellAeRunning {
    return @(Get-Process -Name AfterFX -ErrorAction SilentlyContinue).Count -gt 0
}

# Clear the flag so the next launch shows no recovery prompt.
#
# Returns a hashtable the caller can log verbatim:
#   @{ Cleared = <bool>; Before = <int or $null>; Reason = '<why>' }
#
# The value is REMOVED rather than set to 0, because absent is what AE
# itself writes for a healthy install: measured 2026-09-08, running 26.3
# carried no CrashOccurred value at all while stale 26.2 carried 1.
#
# It REFUSES while After Effects is running. AE owns this key for the
# life of its session and rewrites it on exit, so a clear applied
# underneath a live AE is silently undone -- and a fix that reports
# success while being reverted is worse than no fix, which is the
# preflight lesson from section 20 in a different costume. -Force
# overrides for the case where a caller knows the running AE is about to
# be replaced.
function Clear-AellAeCrashFlag {
    param(
        [Parameter(Mandatory = $true)][string]$VersionKey,
        [switch]$Force
    )

    if (-not (Test-Path -LiteralPath $VersionKey)) {
        return @{ Cleared = $false; Before = $null;
                  Reason = ('no version key at ' + $VersionKey +
                            '; a fresh install has none, so nothing to clear') }
    }

    $before = Get-AellAeCrashFlag -VersionKey $VersionKey

    if ((Test-AellAeRunning) -and -not $Force) {
        return @{ Cleared = $false; Before = $before;
                  Reason = ('After Effects is running; it owns this key and ' +
                            'rewrites it on exit, so clearing now would be ' +
                            'undone. Close AE first, or pass -Force.') }
    }

    if ($null -eq $before) {
        return @{ Cleared = $false; Before = $null;
                  Reason = 'no CrashOccurred value; already clean' }
    }

    try {
        Remove-ItemProperty -LiteralPath $VersionKey -Name 'CrashOccurred' -Force -ErrorAction Stop
    } catch {
        return @{ Cleared = $false; Before = $before;
                  Reason = ('could not remove CrashOccurred: ' + $_.Exception.Message) }
    }

    $after = Get-AellAeCrashFlag -VersionKey $VersionKey
    if ($null -ne $after) {
        return @{ Cleared = $false; Before = $before;
                  Reason = ('CrashOccurred still reads ' + $after +
                            ' after removal; something rewrote it') }
    }

    return @{ Cleared = $true; Before = $before;
              Reason = ('removed CrashOccurred (was ' + $before + ')') }
}
