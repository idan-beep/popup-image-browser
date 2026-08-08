Dim fso, shell, http, scriptDir, port, url, isUp

Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")

port = 5177
url = "http://127.0.0.1:" & port & "/"

isUp = False
On Error Resume Next
Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
http.Open "GET", url, False
http.SetTimeouts 2000, 2000, 2000, 2000
http.Send
If Err.Number = 0 Then
  isUp = True
End If
On Error Goto 0

If Not isUp Then
  If Not fso.FolderExists(scriptDir & "\node_modules") Then
    shell.Run "cmd /c cd /d """ & scriptDir & """ && npm install >> ""server.log"" 2>&1", 0, True
  End If
  shell.Run "cmd /c cd /d """ & scriptDir & """ && node server.js >> ""server.log"" 2>&1", 0, False
  WScript.Sleep 1000
End If

shell.Run "cmd /c start """" """ & url & """", 0, False
