; SessionManagerPro per-user installer. Built by scripts/build-installer.ps1, which stages
; build\stage first and passes /DAppVersion from package.json:
;
;   ISCC.exe /DAppVersion=1.2.0 installer\SessionManagerPro.iss
;
; Everything shipped comes from build\stage (scripts/stage.ps1). The browser engine is not
; shipped: Setup downloads it at the end (and the panel can repeat that from Settings).

#if VER < EncodeVer(6, 6, 0)
  #error Inno Setup 6.6 or newer is required (modern dynamic wizard style, PNG wizard images)
#endif
#ifndef AppVersion
  #error Pass /DAppVersion=x.y.z (scripts/build-installer.ps1 does this)
#endif
#define AppName "SessionManagerPro"
#define AppExe "SessionManagerPro.exe"
#define Stage "..\build\stage"
#define VCRedistUrl "https://aka.ms/vs/17/release/vc_redist.x64.exe"

[Setup]
; Never change the AppId: upgrades and the uninstall entry are keyed on it.
AppId={{8A83969A-BA8E-40EE-8628-18718BA73ED9}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppName}
VersionInfoVersion={#AppVersion}
; Per user, no UAC: {autopf} is %LOCALAPPDATA%\Programs, writable by the app itself (data\, updates\).
PrivilegesRequired=lowest
DefaultDirName={autopf}\{#AppName}
DisableProgramGroupPage=yes
DisableWelcomePage=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern dynamic windows11
WizardSizePercent=120
; Setup picks the image closest to the screen's DPI (installer\make-assets.ps1 draws them).
WizardImageFile=WizardImage-*.png
WizardSmallImageFile=WizardSmallImage-*.png
SetupIconFile=..\assets\SessionManagerPro.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
; The launcher holds this mutex while it runs; Setup asks to close it first.
AppMutex=Local\SessionManagerPro.SingleInstance
CloseApplications=yes
Compression=lzma2/max
SolidCompression=yes
SetupLogging=yes
OutputDir=..\release
OutputBaseFilename=SessionManagerPro-Setup-{#AppVersion}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[InstallDelete]
; Rebuilt wholesale on every version: stale hashed bundles, packages and runtime files must
; not linger. An old *.dist-info left beside a new one breaks invisible_core's version pin,
; and then no browser starts. None of these hold user data.
Type: filesandordirs; Name: "{app}\frontend\dist"
Type: filesandordirs; Name: "{app}\backend\node_modules"
Type: filesandordirs; Name: "{app}\backend\src"
Type: filesandordirs; Name: "{app}\runtime\node"
Type: filesandordirs; Name: "{app}\runtime\python"

[Files]
Source: "{#Stage}\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion
; The dashboard window (WebView2): loaded from beside the exe.
Source: "{#Stage}\Microsoft.Web.WebView2.Core.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Stage}\Microsoft.Web.WebView2.WinForms.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Stage}\WebView2Loader.dll"; DestDir: "{app}"; Flags: ignoreversion
; The panel reads the app version from here.
Source: "{#Stage}\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Stage}\assets\SessionManagerPro.ico"; DestDir: "{app}\assets"; Flags: ignoreversion
Source: "{#Stage}\backend\package.json"; DestDir: "{app}\backend"; Flags: ignoreversion
Source: "{#Stage}\backend\src\*"; DestDir: "{app}\backend\src"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Stage}\backend\node_modules\*"; DestDir: "{app}\backend\node_modules"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Stage}\frontend\dist\*"; DestDir: "{app}\frontend\dist"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Stage}\runtime\node\*"; DestDir: "{app}\runtime\node"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Stage}\runtime\python\*"; DestDir: "{app}\runtime\python"; Flags: ignoreversion recursesubdirs createallsubdirs

[Dirs]
; No flags: these hold the user's data, so the uninstaller leaves them unless asked (below).
Name: "{app}\data"
Name: "{app}\updates"
Name: "{app}\resources\proxies"
Name: "{app}\resources\fpts"

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Written at run time, so the uninstaller does not know them otherwise.
Type: filesandordirs; Name: "{app}\backend\src\__pycache__"
Type: filesandordirs; Name: "{localappdata}\SessionManagerPro\edge_profile"
Type: filesandordirs; Name: "{localappdata}\SessionManagerPro\webview2"
Type: files; Name: "{localappdata}\SessionManagerPro\window.json"
Type: dirifempty; Name: "{localappdata}\SessionManagerPro"

[Code]
const
  VCKey = 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64';

var
  EnginePage: TOutputMarqueeProgressWizardPage;
  Step: String;  { the running step's caption, kept above each output line }

function SetEnvironmentVariable(lpName, lpValue: String): BOOL;
  external 'SetEnvironmentVariableW@kernel32.dll stdcall';

{ The x64 redistributable registers in either registry view depending on its version. }
function VCRuntimeInstalled: Boolean;
var
  Installed: Cardinal;
begin
  Result := (RegQueryDWordValue(HKLM64, VCKey, 'Installed', Installed) and (Installed = 1)) or
            (RegQueryDWordValue(HKLM32, VCKey, 'Installed', Installed) and (Installed = 1));
end;

function InitializeSetup: Boolean;
var
  ErrorCode: Integer;
begin
  Result := True;
  if VCRuntimeInstalled then Exit;
  Log('Visual C++ 2015-2022 x64 runtime not found');
  { Warn and carry on: the app installs fine, only its browsers need the runtime. }
  if SuppressibleMsgBox(
       'The browser engine needs the Microsoft Visual C++ 2015-2022 runtime (x64), which is not installed.' + #13#10#13#10 +
       'Setup will continue. Install the runtime before starting a profile:' + #13#10 + '{#VCRedistUrl}' + #13#10#13#10 +
       'Open the download now?',
       mbInformation, MB_YESNO, IDNO) = IDYES then
    ShellExec('open', '{#VCRedistUrl}', '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
end;

procedure InitializeWizard;
begin
  EnginePage := CreateOutputMarqueeProgressPage('Downloading the browser engine',
    'The patched Firefox is about 240 MB. It is downloaded once and kept for every profile.');
end;

{ Each output line of the running step: shown under the bar and kept in the Setup log. }
procedure EngineLog(const S: String; const Error, FirstLine: Boolean);
begin
  Log('engine: ' + S);
  if Trim(S) <> '' then
    EnginePage.SetText(Step, Trim(S));
  EnginePage.Animate;
end;

{ Runs the bundled Python with the worker's isolation flags; -u streams lines as printed. }
function RunPython(const Status, Args: String): Boolean;
var
  ResultCode: Integer;
begin
  Step := Status;
  EnginePage.SetText(Status, '');
  EnginePage.Animate;
  Result := False;
  try
    Result := ExecAndLogOutput(ExpandConstant('{app}\runtime\python\python.exe'), '-E -s -u ' + Args,
      ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode, @EngineLog) and (ResultCode = 0);
    if not Result then Log(Format('exit code %d', [ResultCode]));
  except
    Log(GetExceptionMessage);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  EngineOk, GeoOk: Boolean;
begin
  if CurStep <> ssPostInstall then Exit;
  { As the app runs it: never pip-install on a version mismatch, never the user site. }
  SetEnvironmentVariable('INVISIBLE_CORE_AUTOFIX', 'off');
  SetEnvironmentVariable('PYTHONNOUSERSITE', '1');
  EnginePage.Show;
  try
    EngineOk := RunPython('Downloading and verifying the browser engine...', '-m invisible_playwright fetch');
    GeoOk := RunPython('Downloading the location database...',
      '-c "from invisible_core import ensure_geoip_mmdb; ensure_geoip_mmdb()"');
  finally
    EnginePage.Hide;
  end;
  if not EngineOk then
    SuppressibleMsgBox('The browser engine could not be downloaded (are you offline?).' + #13#10#13#10 +
      'SessionManagerPro is installed. Download the engine later from Settings > Browser engine, or run Setup again to repair.',
      mbError, MB_OK, IDOK)
  else if not GeoOk then
    SuppressibleMsgBox('The location database could not be downloaded. It is fetched again when a profile first starts; running Setup again also repairs it.',
      mbInformation, MB_OK, IDOK);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep <> usPostUninstall then Exit;
  { The engine cache in %LOCALAPPDATA%\invisible-playwright stays: a developer checkout shares it. }
  if not UninstallSilent and
     (MsgBox('Also delete your profiles, cookies, proxies and logs?' + #13#10#13#10 +
        ExpandConstant('{app}') + #13#10#13#10 + 'This cannot be undone.',
        mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES) then
  begin
    { Only what the app writes: a folder typed into the directory box may hold other things. }
    DelTree(ExpandConstant('{app}\data'), True, True, True);
    DelTree(ExpandConstant('{app}\updates'), True, True, True);
    DelTree(ExpandConstant('{app}\resources'), True, True, True);
    RemoveDir(ExpandConstant('{app}'));
  end;
end;
