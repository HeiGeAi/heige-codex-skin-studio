Option Explicit

Dim shell, fileSystem, scriptDirectory, applyPath, powerShellPath, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
applyPath = fileSystem.BuildPath(scriptDirectory, "apply.ps1")
powerShellPath = shell.ExpandEnvironmentStrings( _
    "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")

shell.Environment("PROCESS")("HEIGE_NO_PAUSE") = "1"
shell.Environment("PROCESS")("HEIGE_SHOW_PAUSE_HINT") = "0"
command = Chr(34) & powerShellPath & Chr(34) & _
    " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & _
    Chr(34) & applyPath & Chr(34)
exitCode = shell.Run(command, 0, True)

If exitCode <> 0 Then
    MsgBox "HeiGe launcher failed. Run apply.bat in a terminal for details.", _
        vbExclamation + vbOKOnly, "HeiGe Codex Skin Studio"
End If

WScript.Quit exitCode
