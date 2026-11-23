; 安裝程式的自訂步驟(electron-builder 會自動載入 build/installer.nsh)。
; 安裝時就註冊 entropy-nexus:// 網址(記憶寶庫 App 的「喚醒舊 session」用),不必等安裝版第一次啟動;
; 寫法和主程式的 app.setAsDefaultProtocolClient 相同(目前使用者的 HKCU\Software\Classes),主程式啟動時仍會再註冊一次。
; 解除安裝時清除;升級(新版安裝程式先執行舊版的解除安裝)時不清,避免中間有一段時間沒有註冊。

!macro customInstall
  WriteRegStr HKCU "Software\Classes\entropy-nexus" "" "URL:entropy-nexus"
  WriteRegStr HKCU "Software\Classes\entropy-nexus" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\entropy-nexus\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\entropy-nexus"
  ${endIf}
!macroend
