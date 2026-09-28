using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace SessionManagerProLauncher
{
    static class Program
    {
        private static Process serverProcess = null;
        private static string edgePath = null;
        private static string edgeProfileDir = null;   // fallback Edge --app window only
        private static string webview2Dir = null;      // our own window (WebView2)
        private static string placementFile = null;    // our window's last bounds
        private static string logFile = null;
        private static string serverLogFile = null;
        private static string baseDir = null;
        // Must match backend/src/server.js. Not 3001: Dolphin{anty}'s Local API uses that port.
        private const int SERVER_PORT = 47301;
        private const string SERVER_URL = "http://127.0.0.1:47301";
        // One copy per Windows session. "Local\" scopes it to the signed-in user.
        private const string INSTANCE_MUTEX = "Local\\SessionManagerPro.SingleInstance";
        // A second launch sets this to ask the running copy to open its dashboard window.
        private const string SHOW_EVENT = "Local\\SessionManagerPro.Show";

        [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] private static extern bool AllowSetForegroundWindow(int processId);
        [DllImport("user32.dll")] private static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
        [DllImport("shcore.dll")] private static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint dpiX, out uint dpiY);
        [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
        [DllImport("user32.dll")] private static extern int GetSystemMetricsForDpi(int index, uint dpi);
        [DllImport("user32.dll")] private static extern bool ReleaseCapture();
        [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        private struct NCCALCSIZE_PARAMS { public RECT rgrc0, rgrc1, rgrc2; public IntPtr lppos; }
        [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }

        private static void Log(string msg)
        {
            try
            {
                if (logFile != null)
                {
                    string line = string.Format("[{0:yyyy-MM-dd HH:mm:ss}] {1}\r\n", DateTime.Now, msg);
                    File.AppendAllText(logFile, line, Encoding.UTF8);
                }
            }
            catch { }
        }

        private static void LogServer(string msg)
        {
            try
            {
                if (serverLogFile != null && !string.IsNullOrEmpty(msg))
                {
                    string line = string.Format("[{0:yyyy-MM-dd HH:mm:ss}] {1}\r\n", DateTime.Now, msg);
                    File.AppendAllText(serverLogFile, line, Encoding.UTF8);
                }
            }
            catch { }
        }

        [STAThread]
        static void Main()
        {
            // Before any window: crisp at 125-175%, and every size below is in physical pixels.
            // PER_MONITOR_AWARE_V2 = -4.
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string appDataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SessionManagerPro");
            edgeProfileDir = Path.Combine(appDataDir, "edge_profile");
            webview2Dir = Path.Combine(appDataDir, "webview2");
            placementFile = Path.Combine(appDataDir, "window.json");

            // Single instance. Starting the app again (even while it sits in the tray) just brings
            // the running copy's window up, the way opening any app does.
            bool firstInstance;
            Mutex instance = new Mutex(true, INSTANCE_MUTEX, out firstInstance);
            if (!firstInstance)
            {
                // The running copy opens the window itself, so it keeps tracking it (close behaviour).
                // No event yet: it is still starting and opens the window once the server answers.
                EventWaitHandle show;
                if (EventWaitHandle.TryOpenExisting(SHOW_EVENT, out show))
                {
                    using (show)
                    {
                        // We hold the foreground (the user just clicked); lend it so the window comes to the front.
                        try { AllowSetForegroundWindow(-1); } catch { }
                        show.Set();
                    }
                }
                return;
            }

            try
            {
                string updatesDir = Path.Combine(baseDir, "updates");
                string backendDir = Path.Combine(baseDir, "backend");
                string serverScript = Path.Combine(backendDir, "src", "server.js");

                if (!Directory.Exists(updatesDir)) Directory.CreateDirectory(updatesDir);
                if (!Directory.Exists(appDataDir)) Directory.CreateDirectory(appDataDir);

                logFile = Path.Combine(updatesDir, "launcher.log");
                serverLogFile = Path.Combine(updatesDir, "server.log");

                Log("====================================================");
                Log("Starting SessionManagerPro Desktop Launcher");
                Log("Base Directory: " + baseDir);

                // 1. A server may already be running (e.g. started with `npm start`); reuse it, but
                // only when it answers as ours: another program on the port must not get the window.
                bool isPortOpen = IsPortOpen("127.0.0.1", SERVER_PORT, 250);
                bool isOurs = isPortOpen && IsOurServer();
                bool waitForServer = false;
                Log("Initial port check (" + SERVER_PORT + "): " + (isOurs ? "ALREADY_ONLINE" : isPortOpen ? "TAKEN_BY_OTHER" : "OFFLINE"));

                if (!isOurs)
                {
                    if (!File.Exists(serverScript))
                    {
                        string err = "Could not locate server script at:\n" + serverScript;
                        Log("FATAL: " + err);
                        MessageBox.Show(err, "SessionManagerPro", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        return;
                    }

                    string nodeExe = FindNodeExecutable();
                    Log("Resolved Node.js path: " + nodeExe);

                    if (string.IsNullOrEmpty(nodeExe))
                    {
                        // An installed copy ships its own Node; if that is gone the install is damaged.
                        string err = Directory.Exists(Path.Combine(baseDir, "runtime"))
                            ? "The bundled Node.js runtime is missing:\n" + Path.Combine(baseDir, "runtime", "node", "node.exe") + "\n\nPlease reinstall SessionManagerPro."
                            : "Node.js (node.exe) was not found on your system.\nPlease install Node.js (v18+) from https://nodejs.org";
                        Log("FATAL: " + err);
                        MessageBox.Show(err, "SessionManagerPro — Node Not Found", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        return;
                    }

                    ProcessStartInfo nodePsi = new ProcessStartInfo
                    {
                        FileName = nodeExe,
                        // The tray app owns the window; no browser tab and no extra console window.
                        Arguments = "\"" + serverScript + "\" --no-open --no-terminal",
                        WorkingDirectory = baseDir,
                        CreateNoWindow = true,
                        UseShellExecute = false,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        WindowStyle = ProcessWindowStyle.Hidden
                    };

                    serverProcess = new Process();
                    serverProcess.StartInfo = nodePsi;
                    serverProcess.OutputDataReceived += (s, e) => { if (e.Data != null) LogServer("OUT: " + e.Data); };
                    serverProcess.ErrorDataReceived += (s, e) => { if (e.Data != null) LogServer("ERR: " + e.Data); };

                    serverProcess.Start();
                    serverProcess.BeginOutputReadLine();
                    serverProcess.BeginErrorReadLine();

                    Log("Spawned Node server process (PID: " + serverProcess.Id + ")");

                    // Wait up to 20 seconds for our server to answer. An open port is not enough:
                    // another program may hold it, and then our server exits reporting the conflict.
                    Stopwatch waited = Stopwatch.StartNew();
                    bool online = false;
                    while (waited.ElapsedMilliseconds < 20000)
                    {
                        if (serverProcess.HasExited)
                        {
                            string exitErr = isPortOpen
                                ? "Port " + SERVER_PORT + " is in use by another program.\nClose it, then start SessionManagerPro again."
                                : "Backend server exited prematurely with code " + serverProcess.ExitCode + ".\nCheck updates/server.log for details.";
                            Log("FATAL: " + exitErr);
                            MessageBox.Show(exitErr, "SessionManagerPro Server Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                            return;
                        }
                        if (IsPortOpen("127.0.0.1", SERVER_PORT, 200) && IsOurServer()) { online = true; break; }
                        Thread.Sleep(250);
                    }

                    Log("Server status: " + (online ? "ONLINE" : "TIMEOUT"));
                    // A slow first start (antivirus scanning node.exe): the tray opens the window
                    // once the server answers, instead of showing a "can't reach this page" now.
                    waitForServer = !online;
                }

                // 2. Our own window (WebView2); the Edge --app window only when that is unavailable.
                bool useWebView = false;
                try
                {
                    string version = WebView2Version();
                    useWebView = !string.IsNullOrEmpty(version);
                    Log("WebView2 Runtime: " + (useWebView ? version : "not installed"));
                }
                catch (Exception ex)
                {
                    Log("WebView2 unavailable (" + ex.GetType().Name + ": " + ex.Message + ")");
                }
                edgePath = FindEdgeExecutable();
                if (useWebView) Log("Dashboard window: WebView2, profile " + webview2Dir);
                else Log("Dashboard window: fallback " + (edgePath ?? "default system browser") + ", profile " + edgeProfileDir);

                // 3. System tray
                TrayAppContext appContext = new TrayAppContext(edgePath, edgeProfileDir, serverProcess, waitForServer, useWebView);
                Log("System tray initialized. Running application loop.");
                Application.Run(appContext);
            }
            catch (Exception ex)
            {
                Log("CRITICAL_EXCEPTION: " + ex.ToString());
                MessageBox.Show(
                    "Error launching SessionManagerPro:\n" + ex.Message,
                    "SessionManagerPro Error",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
            finally
            {
                // Held for the whole run; released so the next launch starts cleanly.
                try { instance.ReleaseMutex(); } catch { }
                instance.Dispose();
            }
        }

        /// <summary>
        /// The installed WebView2 Runtime's version, or null. Throws when the WebView2 DLLs are
        /// missing: kept out of line so that only this call (not Main) needs them to load.
        /// </summary>
        [MethodImpl(MethodImplOptions.NoInlining)]
        internal static string WebView2Version()
        {
            // The x64 loader ships beside the exe (build-exe.ps1, the installer).
            CoreWebView2Environment.SetLoaderDllFolderPath(baseDir);
            return CoreWebView2Environment.GetAvailableBrowserVersionString();
        }

        // ---- window geometry: physical pixels (the process is per-monitor DPI aware) ----

        /// <summary>The panel is laid out for about 1024 DIPs and up; never more than the work area.</summary>
        internal static Size MinWindowSize(Rectangle area, int dpi)
        {
            return new Size(Math.Min(area.Width, 1100 * dpi / 96), Math.Min(area.Height, 660 * dpi / 96));
        }

        /// <summary>16:9, 82% of the work-area width (or 88% of its height if that is the limit), centred.</summary>
        internal static Rectangle FirstRunBounds(Rectangle area, Size min)
        {
            int w = area.Width * 82 / 100, h = w * 9 / 16;
            if (h > area.Height * 88 / 100) { h = area.Height * 88 / 100; w = h * 16 / 9; }
            // Small screens: grow to the minimum, still 16:9 while the work area allows it.
            if (h < min.Height) { h = min.Height; w = h * 16 / 9; }
            if (w < min.Width) { w = min.Width; h = w * 9 / 16; }
            return FitToArea(new Rectangle(0, 0, w, h), area, min, true);
        }

        /// <summary>At least the minimum, wholly inside the work area; centred when asked.</summary>
        internal static Rectangle FitToArea(Rectangle r, Rectangle area, Size min, bool centre)
        {
            int w = Math.Min(area.Width, Math.Max(min.Width, r.Width));
            int h = Math.Min(area.Height, Math.Max(min.Height, r.Height));
            int x = centre ? area.X + (area.Width - w) / 2 : Math.Max(area.X, Math.Min(r.X, area.Right - w));
            int y = centre ? area.Y + (area.Height - h) / 2 : Math.Max(area.Y, Math.Min(r.Y, area.Bottom - h));
            return new Rectangle(x, y, w, h);
        }

        /// <summary>The monitor's effective DPI (96 = 100%).</summary>
        internal static int MonitorDpi(Screen screen)
        {
            try
            {
                POINT p = new POINT { X = screen.Bounds.X + screen.Bounds.Width / 2, Y = screen.Bounds.Y + screen.Bounds.Height / 2 };
                uint dx, dy;
                if (GetDpiForMonitor(MonitorFromPoint(p, 2 /* NEAREST */), 0 /* EFFECTIVE */, out dx, out dy) == 0 && dx > 0) return (int)dx;
            }
            catch { }
            return 96;
        }

        internal static bool ReadPlacement(string path, out Rectangle bounds, out bool maximized)
        {
            bounds = Rectangle.Empty;
            maximized = false;
            try
            {
                if (!File.Exists(path)) return false;
                string json = File.ReadAllText(path);
                string[] keys = { "x", "y", "width", "height" };
                int[] v = new int[4];
                for (int i = 0; i < 4; i++)
                {
                    Match m = Regex.Match(json, "\"" + keys[i] + "\"\\s*:\\s*(-?\\d+)");
                    if (!m.Success) return false;
                    v[i] = int.Parse(m.Groups[1].Value);
                }
                if (v[2] < 200 || v[3] < 200) return false;
                bounds = new Rectangle(v[0], v[1], v[2], v[3]);
                maximized = Regex.IsMatch(json, "\"maximized\"\\s*:\\s*true");
                return true;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>Only http(s) leaves the app, and only to the default browser.</summary>
        private static void OpenExternal(string uri)
        {
            Uri u;
            if (!Uri.TryCreate(uri, UriKind.Absolute, out u) || (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps)) return;
            try { Process.Start(u.AbsoluteUri); }
            catch (Exception ex) { Log("Could not open " + u.AbsoluteUri + ": " + ex.Message); }
        }

        /// <summary>The panel itself (and its blob: downloads); anything else is not ours to show.</summary>
        internal static bool IsPanelUrl(string uri)
        {
            if (uri != null && uri.StartsWith("blob:", StringComparison.OrdinalIgnoreCase)) uri = uri.Substring(5);
            Uri u;
            return Uri.TryCreate(uri, UriKind.Absolute, out u) && u.Scheme == Uri.UriSchemeHttp && u.Host == "127.0.0.1" && u.Port == SERVER_PORT;
        }

        /// <summary>Fallback: opens the dashboard as an Edge app window, or in the default browser. Returns the process we started, if any.</summary>
        private static Process StartDashboard(string browser, string profileDir)
        {
            try
            {
                if (!string.IsNullOrEmpty(browser) && File.Exists(browser))
                {
                    string args = string.Format(
                        "--app={0} {2}--user-data-dir=\"{1}\" " +
                        "--no-first-run --no-default-browser-check " +
                        "--disable-features=Translate,OptimizationHints,MediaRouter,EdgeMiniMenu,EdgeSuperDragDrop,msEdgeReadingView " +
                        "--disable-extensions --disable-component-update --disable-default-apps " +
                        "--disable-background-networking --disable-sync",
                        SERVER_URL,
                        profileDir,
                        FirstWindowBounds(profileDir)
                    );
                    Log("Opening dashboard window: " + browser + " " + args);
                    return Process.Start(new ProcessStartInfo { FileName = browser, Arguments = args, UseShellExecute = false });
                }
                Log("Opening in default browser: " + SERVER_URL);
                Process.Start(SERVER_URL);
            }
            catch (Exception ex)
            {
                Log("StartDashboard error: " + ex.Message);
                try { Process.Start(SERVER_URL); } catch { }
            }
            return null;
        }

        /// <summary>
        /// Size and position for the very first Edge window only. Chromium applies command-line bounds
        /// over its saved placement on every launch (and un-maximizes), so once the profile has
        /// remembered a placement we pass nothing and the user's size and maximized state stick.
        /// </summary>
        private static string FirstWindowBounds(string profileDir)
        {
            try
            {
                string prefs = Path.Combine(profileDir, "Default", "Preferences");
                if (File.Exists(prefs) && File.ReadAllText(prefs).Contains("\"app_window_placement\"")) return "";
            }
            catch { }
            Screen screen = Screen.PrimaryScreen;
            int dpi = MonitorDpi(screen);
            Rectangle r = FirstRunBounds(screen.WorkingArea, MinWindowSize(screen.WorkingArea, dpi));
            // Our bounds are pixels; --window-size and --window-position take DIPs.
            return string.Format("--window-size={0},{1} --window-position={2},{3} ",
                r.Width * 96 / dpi, r.Height * 96 / dpi, r.X * 96 / dpi, r.Y * 96 / dpi);
        }

        /// <summary>True when the port answers GET /api/app the way our server does.</summary>
        private static bool IsOurServer()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(SERVER_URL + "/api/app");
                req.Timeout = 1000;
                req.ReadWriteTimeout = 1000;
                req.Proxy = null; // a system proxy must never see loopback traffic
                using (WebResponse resp = req.GetResponse())
                using (StreamReader r = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                    return r.ReadToEnd().Contains("\"closeBehavior\"");
            }
            catch
            {
                return false;
            }
        }

        /// <summary>"tray" or "quit", as chosen in the panel's Settings (data/app.json). The default must match server.js.</summary>
        private static string ReadCloseBehavior()
        {
            try
            {
                string json = File.ReadAllText(Path.Combine(baseDir, "data", "app.json"));
                Match m = Regex.Match(json, "\"closeBehavior\"\\s*:\\s*\"(\\w+)\"");
                if (m.Success) return m.Groups[1].Value;
            }
            catch { }
            return "quit";
        }

        /// <summary>Profiles running or waiting to launch, from the server; -1 when it does not answer.</summary>
        internal static int RunningCount()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(SERVER_URL + "/api/stats");
                req.Timeout = 2000;
                req.ReadWriteTimeout = 2000;
                req.Proxy = null; // a system proxy must never see loopback traffic
                using (WebResponse resp = req.GetResponse())
                using (StreamReader r = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    string json = r.ReadToEnd();
                    Match live = Regex.Match(json, "\"activeThreads\"\\s*:\\s*(\\d+)");
                    Match queued = Regex.Match(json, "\"queuedCount\"\\s*:\\s*(\\d+)");
                    if (!live.Success) return -1;
                    return int.Parse(live.Groups[1].Value) + (queued.Success ? int.Parse(queued.Groups[1].Value) : 0);
                }
            }
            catch
            {
                return -1;
            }
        }

        /// <summary>Asks the server to close every browser (saving cookies) and exit.</summary>
        private static bool RequestServerQuit()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(SERVER_URL + "/api/app/quit");
                req.Method = "POST";
                req.ContentType = "application/json";
                req.Headers.Add("X-SMP", "1");
                req.Timeout = 4000;
                byte[] body = Encoding.UTF8.GetBytes("{}");
                req.ContentLength = body.Length;
                using (Stream s = req.GetRequestStream()) s.Write(body, 0, body.Length);
                using (WebResponse resp = req.GetResponse()) { }
                return true;
            }
            catch (Exception ex)
            {
                Log("Quit request failed: " + ex.Message);
                return false;
            }
        }

        /// <summary>The app icon (assets/SessionManagerPro.ico, embedded) at the given size.</summary>
        private static Icon AppIcon(Size size)
        {
            try
            {
                using (Stream s = typeof(Program).Assembly.GetManifestResourceStream("SessionManagerPro.ico"))
                    return new Icon(s, size);
            }
            catch
            {
                return SystemIcons.Application;
            }
        }

        internal enum CloseChoice { Cancel, Tray, Quit }

        /// <summary>
        /// Closing while profiles run: keep them running in the tray, stop them and quit, or cancel.
        /// Plain WinForms laid out by its font, so it follows the display scale.
        /// </summary>
        internal class CloseDialog : Form
        {
            private CloseChoice _choice = CloseChoice.Cancel;
            private readonly float _scale;

            /// <param name="owner">The dashboard window, if it is showing; else the dialog centres on screen.</param>
            /// <param name="running">Profiles running or queued; -1 when unknown.</param>
            /// <param name="offerTray">False for the tray's own Quit: it is in the tray already.</param>
            internal static CloseChoice Ask(Form owner, int running, bool offerTray)
            {
                using (CloseDialog d = new CloseDialog(running, offerTray))
                {
                    bool overOwner = owner != null && owner.Visible && owner.WindowState != FormWindowState.Minimized;
                    if (!overOwner)
                    {
                        d.StartPosition = FormStartPosition.CenterScreen;
                        d.ShowInTaskbar = true;
                        d.TopMost = true;
                    }
                    d.ShowDialog(overOwner ? owner : null);
                    return d._choice;
                }
            }

            internal CloseDialog(int running, bool offerTray)
            {
                _scale = DeviceDpi / 96f;
                string count = running == 1 ? "1 profile" : running + " profiles";
                string heading = offerTray
                    ? (running < 0 ? "Profiles may still be running" : count + (running == 1 ? " is" : " are") + " still running")
                    : "Stop " + (running < 0 ? "every running profile" : running == 1 ? "the running profile" : running == 2 ? "both running profiles" : "all " + running + " running profiles") + " and quit?";
                string message = offerTray
                    ? "Keep them running in the background, with SessionManagerPro in the tray, or stop them and quit. Stopping saves each profile's cookies first."
                    : "Each profile's cookies are saved first.";

                Text = "SessionManagerPro";
                Font = new Font("Segoe UI", 9f);
                AutoScaleMode = AutoScaleMode.None;
                FormBorderStyle = FormBorderStyle.FixedDialog;
                MaximizeBox = false;
                MinimizeBox = false;
                ShowIcon = false;
                ShowInTaskbar = false;
                StartPosition = FormStartPosition.CenterParent;
                AutoSize = true;
                AutoSizeMode = AutoSizeMode.GrowAndShrink;
                BackColor = Color.White;

                TableLayoutPanel content = new TableLayoutPanel
                {
                    AutoSize = true,
                    AutoSizeMode = AutoSizeMode.GrowAndShrink,
                    ColumnCount = 2,
                    Padding = new Padding(Px(22), Px(20), Px(26), Px(18)),
                    Margin = Padding.Empty,
                    Dock = DockStyle.Fill,
                };
                PictureBox icon = new PictureBox
                {
                    Image = AppIcon(new Size(Px(32), Px(32))).ToBitmap(),
                    SizeMode = PictureBoxSizeMode.Zoom,
                    Size = new Size(Px(32), Px(32)),
                    Margin = new Padding(0, Px(1), Px(14), 0),
                };
                content.Controls.Add(icon, 0, 0);
                content.SetRowSpan(icon, 3);
                content.Controls.Add(TextLabel(heading, new Font("Segoe UI Semibold", 11.5f), Color.FromArgb(0x16, 0x18, 0x1d), Px(6)), 1, 0);
                content.Controls.Add(TextLabel(message, Font, Color.FromArgb(0x3d, 0x41, 0x4b), offerTray ? Px(10) : 0), 1, 1);
                if (offerTray)
                    content.Controls.Add(TextLabel("To change what closing does: Settings \u2192 App.", Font, Color.FromArgb(0x7c, 0x80, 0x8a), 0), 1, 2);

                FlowLayoutPanel footer = new FlowLayoutPanel
                {
                    AutoSize = true,
                    AutoSizeMode = AutoSizeMode.GrowAndShrink,
                    FlowDirection = FlowDirection.RightToLeft,
                    WrapContents = false,
                    Dock = DockStyle.Fill,
                    BackColor = Color.FromArgb(0xf1, 0xf2, 0xf5),
                    Padding = new Padding(Px(14), Px(12), Px(14), Px(12)),
                    Margin = Padding.Empty,
                };
                Button cancel = ChoiceButton("Cancel", CloseChoice.Cancel);
                Button quit = ChoiceButton(offerTray ? "Stop all and quit" : "Stop and quit", CloseChoice.Quit);
                footer.Controls.Add(cancel);
                footer.Controls.Add(quit);
                Button primary = quit;
                if (offerTray)
                {
                    // The safe choice is the default: nothing running is lost by pressing Enter.
                    primary = ChoiceButton("Keep running in tray", CloseChoice.Tray);
                    footer.Controls.Add(primary);
                }
                AcceptButton = primary;
                CancelButton = cancel;

                TableLayoutPanel root = new TableLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 1, Margin = Padding.Empty };
                root.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
                root.Controls.Add(content, 0, 0);
                root.Controls.Add(footer, 0, 1);
                Controls.Add(root);
                Shown += (s, e) => primary.Focus();
            }

            private int Px(int v) { return (int)Math.Round(v * _scale); }

            private Label TextLabel(string text, Font font, Color color, int below)
            {
                return new Label
                {
                    Text = text,
                    Font = font,
                    ForeColor = color,
                    AutoSize = true,
                    MaximumSize = new Size(Px(380), 0),
                    Margin = new Padding(0, 0, 0, below),
                };
            }

            private Button ChoiceButton(string text, CloseChoice choice)
            {
                Button b = new Button
                {
                    Text = text,
                    AutoSize = true,
                    AutoSizeMode = AutoSizeMode.GrowOnly,
                    MinimumSize = new Size(Px(92), Px(30)),
                    Padding = new Padding(Px(10), 0, Px(10), 0),
                    Margin = new Padding(Px(8), 0, 0, 0),
                    UseVisualStyleBackColor = true,
                };
                b.Click += (s, e) =>
                {
                    _choice = choice;
                    Close();
                };
                return b;
            }
        }

        /// <summary>
        /// The dashboard in our own window: WebView2 on a form that remembers its bounds and
        /// cannot shrink below what the panel lays out at.
        /// </summary>
        public class DashboardForm : Form
        {
            private const int WM_DPICHANGED = 0x02E0;
            internal static readonly Color Dark = Color.FromArgb(0x11, 0x12, 0x16);   // the panel's --bg
            internal static readonly Color Light = Color.FromArgb(0xFB, 0xFB, 0xFC);  // its light theme
            /// <summary>Reports the panel's theme (what "system" resolved to) as it changes.</summary>
            private const string ThemeWatch =
                "(function () { var send = function () { try { window.chrome.webview.postMessage(" +
                "'theme:' + (document.documentElement.getAttribute('data-theme') || 'dark')); } catch (e) {} };" +
                " new MutationObserver(send).observe(document.documentElement," +
                " { attributes: true, attributeFilter: ['data-theme'] });" +
                " document.addEventListener('DOMContentLoaded', send); send(); })();";
            private readonly WebView2 _web;
            private readonly string _placementFile;
            private readonly Func<bool> _onCloseRequested;
            private readonly Action<Exception> _onFailed;
            private readonly bool _devTools = Environment.GetEnvironmentVariable("SMP_DEVTOOLS") == "1";
            private bool _maximized;
            private bool _exiting;
            private bool _lightTheme;
            private readonly TitleBar _bar;

            /// <param name="onCloseRequested">The user or the page asks to close the window: true hides it, false keeps it open.</param>
            /// <param name="onFailed">WebView2 could not start.</param>
            public DashboardForm(string userDataDir, string placementFile, Func<bool> onCloseRequested, Action<Exception> onFailed)
            {
                _placementFile = placementFile;
                _onCloseRequested = onCloseRequested;
                _onFailed = onFailed;
                Text = "SessionManagerPro";
                Icon = AppIcon(SystemInformation.IconSize);
                BackColor = Dark;
                // Bounds and minimum are computed per monitor in pixels; WinForms must not rescale them.
                AutoScaleMode = AutoScaleMode.None;
                StartPosition = FormStartPosition.Manual;
                Place();

                // Our own caption: taller than Windows' 32 px, and it follows the panel's theme.
                // WM_NCCALCSIZE below takes the system one away; this sits in the client area.
                _bar = new TitleBar(this) { Dock = DockStyle.Top };
                _web = new WebView2();
                _web.Dock = DockStyle.Fill;
                _web.DefaultBackgroundColor = Dark; // no white flash while the page loads
                _web.CreationProperties = new CoreWebView2CreationProperties { UserDataFolder = userDataDir };
                _web.KeyDown += OnKey;
                Controls.Add(_web);
                Controls.Add(_bar); // added last: Dock.Top over the filled WebView2
                Init();
            }

            /// <summary>Last session's bounds (clamped to a screen that still exists), else a centred 16:9.</summary>
            private void Place()
            {
                Rectangle saved;
                bool max;
                bool have = ReadPlacement(_placementFile, out saved, out max);
                Screen screen = have ? Screen.FromRectangle(saved) : Screen.PrimaryScreen;
                Rectangle area = screen.WorkingArea;
                Size min = MinWindowSize(area, MonitorDpi(screen));
                MinimumSize = min;
                Bounds = have ? FitToArea(saved, area, min, false) : FirstRunBounds(area, min);
                _maximized = have && max;
                if (_maximized) WindowState = FormWindowState.Maximized;
            }

            private async void Init()
            {
                try
                {
                    await _web.EnsureCoreWebView2Async(null);
                    CoreWebView2 core = _web.CoreWebView2;
                    core.Settings.AreDevToolsEnabled = _devTools;
                    core.Settings.AreBrowserAcceleratorKeysEnabled = _devTools; // copy/paste still work
                    core.Settings.IsStatusBarEnabled = false;
                    // The panel zooms itself (Ctrl+=/-/0, Ctrl+wheel reach the page); the host
                    // stays at ZoomFactor 1.0.
                    core.Settings.IsZoomControlEnabled = false;
                    core.Settings.IsPinchZoomEnabled = false;
                    // The panel's own Quit calls window.close() once the server is gone.
                    core.WindowCloseRequested += (s, e) => { if (_onCloseRequested()) Hide(); };
                    core.NewWindowRequested += (s, e) => { e.Handled = true; OpenExternal(e.Uri); };
                    core.NavigationStarting += (s, e) =>
                    {
                        if (IsPanelUrl(e.Uri)) return;
                        e.Cancel = true;
                        OpenExternal(e.Uri);
                    };
                    core.ContextMenuRequested += (s, e) =>
                    {
                        if (_devTools) return;
                        for (int i = e.MenuItems.Count - 1; i >= 0; i--)
                            if (e.MenuItems[i].Name == "inspectElement") e.MenuItems.RemoveAt(i);
                    };
                    core.ProcessFailed += (s, e) => Log("WebView2 process failed: " + e.ProcessFailedKind + " (F5 reloads)");
                    core.WebMessageReceived += (s, e) =>
                    {
                        string msg = null;
                        try { msg = e.TryGetWebMessageAsString(); } catch { return; } // not a string: not ours
                        if (msg != null && msg.StartsWith("theme:")) ApplyTitleTheme(msg.Substring(6) == "light");
                    };
                    await core.AddScriptToExecuteOnDocumentCreatedAsync(ThemeWatch);
                    core.Navigate(SERVER_URL);
                }
                catch (Exception ex)
                {
                    _onFailed(ex);
                }
            }

            /// <summary>
            /// Paints the title bar like the panel. Windows leaves a WinForms window the LIGHT
            /// caption even when the system runs in dark mode, so without this a dark panel wears
            /// a white bar.
            /// </summary>
            internal void ApplyTitleTheme(bool light)
            {
                _lightTheme = light;
                BackColor = light ? Light : Dark;
                if (_bar != null) _bar.ApplyTheme(light);
                if (_web != null)
                {
                    try { _web.DefaultBackgroundColor = BackColor; } catch { }
                }
                if (!IsHandleCreated) return;
                int dark = light ? 0 : 1;
                // 20 = DWMWA_USE_IMMERSIVE_DARK_MODE on Windows 10 2004+; 19 on the builds before it.
                SetDwm(20, dark);
                SetDwm(19, dark);
                // Windows 11 only: the exact colours, so the bar matches the panel and not the
                // shell's own dark grey. COLORREF is 0x00BBGGRR.
                SetDwm(35, light ? 0x00FCFBFB : 0x00161211); // DWMWA_CAPTION_COLOR
                SetDwm(36, light ? 0x001C1817 : 0x00F1ECEC); // DWMWA_TEXT_COLOR
                SetDwm(34, light ? 0x00EAE6E6 : 0x001F1E1B); // DWMWA_BORDER_COLOR
            }

            /// <summary>Best effort: an attribute this Windows build does not know is not an error here.</summary>
            private void SetDwm(int attribute, int value)
            {
                try { DwmSetWindowAttribute(Handle, attribute, ref value, sizeof(int)); }
                catch { }
            }

            protected override void OnHandleCreated(EventArgs e)
            {
                base.OnHandleCreated(e);
                ApplyTitleTheme(_lightTheme);
            }

            private void OnKey(object sender, KeyEventArgs e)
            {
                if (_web.CoreWebView2 == null) return;
                if (e.KeyCode == Keys.F5)
                {
                    e.Handled = true;
                    _web.CoreWebView2.Reload();
                }
                else if (_devTools && e.KeyCode == Keys.I && e.Control && e.Shift)
                {
                    e.Handled = true;
                    _web.CoreWebView2.OpenDevToolsWindow();
                }
            }

            /// <summary>Shows the window again, un-minimized and in front.</summary>
            public void Reveal()
            {
                if (!Visible) Show();
                if (WindowState == FormWindowState.Minimized)
                    WindowState = _maximized ? FormWindowState.Maximized : FormWindowState.Normal;
                Activate();
            }

            /// <summary>A real exit: no close-to-tray, the WebView goes too.</summary>
            public void CloseForGood()
            {
                _exiting = true;
                Close();
                Dispose();
            }

            protected override void OnResize(EventArgs e)
            {
                base.OnResize(e);
                if (WindowState != FormWindowState.Minimized) _maximized = WindowState == FormWindowState.Maximized;
            }

            protected override void OnFormClosing(FormClosingEventArgs e)
            {
                SavePlacement();
                base.OnFormClosing(e);
                if (_exiting || e.CloseReason != CloseReason.UserClosing) return;
                e.Cancel = true;
                if (_onCloseRequested()) Hide();
            }

            /// <summary>The caption's height in this monitor's pixels: taller than the system's.</summary>
            internal int BarHeight { get { return (int)Math.Round(44 * MonitorDpi(Screen.FromControl(this)) / 96.0); } }

            /// <summary>The resize frame Windows would have drawn, in pixels (it stays; only the caption goes).</summary>
            private int FrameSize
            {
                get
                {
                    uint dpi = (uint)MonitorDpi(Screen.FromControl(this));
                    try { return GetSystemMetricsForDpi(32 /* SM_CXSIZEFRAME */, dpi) + GetSystemMetricsForDpi(92 /* SM_CXPADDEDBORDER */, dpi); }
                    catch { return SystemInformation.FrameBorderSize.Width; }
                }
            }

            protected override void WndProc(ref Message m)
            {
                const int WM_NCCALCSIZE = 0x0083, WM_NCHITTEST = 0x0084;
                // Give the caption's space back to the client area, keeping the resize frame. A
                // maximized window sits `FrameSize` outside the monitor, so its own frame is
                // trimmed instead, or the top of the page would be under the screen edge.
                if (m.Msg == WM_NCCALCSIZE && m.WParam != IntPtr.Zero)
                {
                    NCCALCSIZE_PARAMS p = (NCCALCSIZE_PARAMS)Marshal.PtrToStructure(m.LParam, typeof(NCCALCSIZE_PARAMS));
                    if (WindowState == FormWindowState.Maximized)
                    {
                        int f = FrameSize;
                        p.rgrc0.Left += f;
                        p.rgrc0.Top += f;
                        p.rgrc0.Right -= f;
                        p.rgrc0.Bottom -= f;
                    }
                    Marshal.StructureToPtr(p, m.LParam, false);
                    m.Result = IntPtr.Zero;
                    return;
                }
                // Windows no longer knows where the edges are: say so, so resizing still works.
                if (m.Msg == WM_NCHITTEST && WindowState != FormWindowState.Maximized)
                {
                    Point pt = PointToClient(new Point((short)((long)m.LParam & 0xFFFF), (short)(((long)m.LParam >> 16) & 0xFFFF)));
                    int g = Math.Max(4, FrameSize); // grab band, generous enough to hit with a mouse
                    bool left = pt.X <= g, right = pt.X >= ClientSize.Width - g;
                    bool top = pt.Y <= g, bottom = pt.Y >= ClientSize.Height - g;
                    int hit =
                        top && left ? 13 : top && right ? 14 : bottom && left ? 16 : bottom && right ? 17 :
                        left ? 10 : right ? 11 : top ? 12 : bottom ? 15 : 0;
                    if (hit != 0)
                    {
                        m.Result = (IntPtr)hit;
                        return;
                    }
                }
                if (m.Msg == WM_DPICHANGED)
                {
                    // Moved to a monitor with another scale: take Windows' suggested rect, and a
                    // minimum in that monitor's pixels.
                    int dpi = (int)((long)m.WParam & 0xFFFF);
                    RECT r = (RECT)Marshal.PtrToStructure(m.LParam, typeof(RECT));
                    Rectangle suggested = Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
                    MinimumSize = Size.Empty;
                    Bounds = suggested;
                    MinimumSize = MinWindowSize(Screen.FromRectangle(suggested).WorkingArea, dpi);
                    m.Result = IntPtr.Zero;
                    return;
                }
                base.WndProc(ref m);
            }

            private void SavePlacement()
            {
                try
                {
                    Rectangle b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                    if (b.Width <= 0 || b.Height <= 0) return;
                    Directory.CreateDirectory(Path.GetDirectoryName(_placementFile));
                    File.WriteAllText(_placementFile, string.Format(
                        "{{\"x\":{0},\"y\":{1},\"width\":{2},\"height\":{3},\"maximized\":{4}}}",
                        b.X, b.Y, b.Width, b.Height, _maximized ? "true" : "false"));
                }
                catch (Exception ex)
                {
                    Log("Could not save window placement: " + ex.Message);
                }
            }
        }

        /// <summary>
        /// The window's caption, drawn by us: the app icon and name on the left, minimise,
        /// maximise and close on the right, in the panel's own colours. Dragging, double-click to
        /// maximise and the system menu behave as Windows' own caption does.
        /// </summary>
        internal class TitleBar : Control
        {
            private const int WM_NCLBUTTONDOWN = 0x00A1, HTCAPTION = 2;
            private readonly DashboardForm _form;
            private readonly Icon _icon;
            private int _hot = -1; // the button under the pointer: 0 minimise, 1 maximise, 2 close
            private bool _light;

            internal TitleBar(DashboardForm form)
            {
                _form = form;
                _icon = AppIcon(new Size(16, 16));
                Height = form.BarHeight;
                DoubleBuffered = true;
                SetStyle(ControlStyles.ResizeRedraw | ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint, true);
            }

            internal void ApplyTheme(bool light)
            {
                _light = light;
                BackColor = light ? DashboardForm.Light : DashboardForm.Dark;
                Invalidate();
            }

            private Color Ink { get { return _light ? Color.FromArgb(0x17, 0x18, 0x1C) : Color.FromArgb(0xEC, 0xEC, 0xF1); } }
            private Color Line { get { return _light ? Color.FromArgb(0xE8, 0xE8, 0xEC) : Color.FromArgb(0x24, 0x25, 0x2A); } }
            private int ButtonWidth { get { return (int)Math.Round(46 * DeviceDpi / 96.0); } }

            /// <summary>The three caption buttons, right to left: close, maximise, minimise.</summary>
            private Rectangle ButtonRect(int i) { return new Rectangle(Width - ButtonWidth * (3 - i), 0, ButtonWidth, Height); }

            private int ButtonAt(Point p)
            {
                for (int i = 0; i < 3; i++) if (ButtonRect(i).Contains(p)) return i;
                return -1;
            }

            protected override void OnMouseMove(MouseEventArgs e)
            {
                base.OnMouseMove(e);
                int was = _hot;
                _hot = ButtonAt(e.Location);
                if (was != _hot) Invalidate();
            }

            protected override void OnMouseLeave(EventArgs e)
            {
                base.OnMouseLeave(e);
                if (_hot != -1) { _hot = -1; Invalidate(); }
            }

            protected override void OnMouseDown(MouseEventArgs e)
            {
                base.OnMouseDown(e);
                int i = ButtonAt(e.Location);
                if (e.Button == MouseButtons.Left && i < 0)
                {
                    // Let Windows run the drag: snapping and the edges come free that way.
                    ReleaseCapture();
                    SendMessage(_form.Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
                }
            }

            protected override void OnMouseUp(MouseEventArgs e)
            {
                base.OnMouseUp(e);
                if (e.Button != MouseButtons.Left) return;
                switch (ButtonAt(e.Location))
                {
                    case 0: _form.WindowState = FormWindowState.Minimized; break;
                    case 1: ToggleMax(); break;
                    case 2: _form.Close(); break;
                }
            }

            protected override void OnMouseDoubleClick(MouseEventArgs e)
            {
                base.OnMouseDoubleClick(e);
                if (e.Button == MouseButtons.Left && ButtonAt(e.Location) < 0) ToggleMax();
            }

            private void ToggleMax()
            {
                _form.WindowState = _form.WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                Graphics g = e.Graphics;
                g.Clear(BackColor);
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                int pad = (int)Math.Round(14 * DeviceDpi / 96.0);
                int size = (int)Math.Round(16 * DeviceDpi / 96.0);
                g.DrawIcon(_icon, new Rectangle(pad, (Height - size) / 2, size, size));
                using (var f = new Font("Segoe UI", 12f * DeviceDpi / 96f, FontStyle.Regular, GraphicsUnit.Pixel))
                using (var ink = new SolidBrush(Ink))
                {
                    var box = new RectangleF(pad + size + pad / 2f, 0, Width - ButtonWidth * 3f, Height);
                    var fmt = new StringFormat { LineAlignment = StringAlignment.Center, Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap };
                    g.DrawString(_form.Text, f, ink, box, fmt);
                }
                for (int i = 0; i < 3; i++)
                {
                    Rectangle r = ButtonRect(i);
                    if (_hot == i)
                    {
                        Color hot = i == 2 ? Color.FromArgb(0xC4, 0x2B, 0x1C) : _light ? Color.FromArgb(0xE6, 0xE6, 0xEA) : Color.FromArgb(0x2A, 0x2B, 0x31);
                        using (var b = new SolidBrush(hot)) g.FillRectangle(b, r);
                    }
                    Color ink = _hot == 2 && i == 2 ? Color.White : Ink;
                    using (var pen = new Pen(ink, Math.Max(1f, DeviceDpi / 96f)))
                    {
                        int s = (int)Math.Round(10 * DeviceDpi / 96.0);
                        int cx = r.X + r.Width / 2, cy = r.Y + r.Height / 2;
                        if (i == 0) g.DrawLine(pen, cx - s / 2, cy, cx + s / 2, cy);
                        else if (i == 1)
                        {
                            if (_form.WindowState == FormWindowState.Maximized)
                            {
                                g.DrawRectangle(pen, cx - s / 2, cy - s / 2 + 2, s - 2, s - 2);
                                g.DrawLine(pen, cx - s / 2 + 2, cy - s / 2, cx + s / 2, cy - s / 2);
                                g.DrawLine(pen, cx + s / 2, cy - s / 2, cx + s / 2, cy + s / 2 - 2);
                            }
                            else g.DrawRectangle(pen, cx - s / 2, cy - s / 2, s, s);
                        }
                        else
                        {
                            g.DrawLine(pen, cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2);
                            g.DrawLine(pen, cx + s / 2, cy - s / 2, cx - s / 2, cy + s / 2);
                        }
                    }
                }
                using (var pen = new Pen(Line)) g.DrawLine(pen, 0, Height - 1, Width, Height - 1);
            }
        }

        public class TrayAppContext : ApplicationContext
        {
            private readonly string _edgePath;
            private readonly string _edgeProfileDir;
            private readonly Process _nodeProcess;
            private readonly NotifyIcon _trayIcon;
            private readonly Control _ui;          // marshals process events back to the UI thread
            private readonly EventWaitHandle _showEvent;
            private readonly RegisteredWaitHandle _showWait;
            private readonly System.Windows.Forms.Timer _poll;
            private bool _useWebView;
            private DashboardForm _window;
            private bool _shuttingDown;
            private bool _toldAboutTray;
            private bool _windowWasOpen;
            private int _ticks;
            private int _portMisses;
            private bool _waitingForServer;

            public TrayAppContext(string edgePath, string edgeProfileDir, Process nodeProcess, bool waitForServer, bool useWebView)
            {
                _edgePath = edgePath;
                _edgeProfileDir = edgeProfileDir;
                _nodeProcess = nodeProcess;
                _waitingForServer = waitForServer;
                _useWebView = useWebView;

                _ui = new Control();
                IntPtr handle = _ui.Handle; // force handle creation so BeginInvoke works

                AppDomain.CurrentDomain.ProcessExit += (s, e) => KillServerIfRunning();

                _trayIcon = new NotifyIcon();
                _trayIcon.Icon = AppIcon(SystemInformation.SmallIconSize);
                _trayIcon.Text = "SessionManagerPro";
                _trayIcon.Visible = true;

                ContextMenu menu = new ContextMenu();
                menu.MenuItems.Add(new MenuItem("Open SessionManagerPro", (s, e) => LaunchWindow()) { DefaultItem = true });
                menu.MenuItems.Add(new MenuItem("Open in default browser", (s, e) => {
                    try { Process.Start(SERVER_URL); } catch { }
                }));
                menu.MenuItems.Add("-");
                menu.MenuItems.Add(new MenuItem("Quit SessionManagerPro", (s, e) => QuitFromTray()));
                _trayIcon.ContextMenu = menu;
                // One click opens the window, like the taskbar button of a running app.
                _trayIcon.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) LaunchWindow(); };

                // The server can end on its own — "Quit" in the panel, or a crash. Either way the
                // tray has nothing left to manage.
                if (_nodeProcess != null)
                {
                    _nodeProcess.EnableRaisingEvents = true;
                    _nodeProcess.Exited += (s, e) => Post(OnServerExited);
                }

                // A second launch asks us to open the window (see SHOW_EVENT).
                _showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, SHOW_EVENT);
                _showWait = ThreadPool.RegisterWaitForSingleObject(_showEvent, (st, timedOut) => Post(LaunchWindow), null, -1, false);

                _poll = new System.Windows.Forms.Timer { Interval = 1000 };
                _poll.Tick += (s, e) => OnPoll();
                _poll.Start();

                if (_waitingForServer) _trayIcon.Text = "SessionManagerPro — starting…";
                else LaunchWindow();
            }

            /// <summary>Runs on the UI thread; a no-op once the tray is gone.</summary>
            private void Post(Action action)
            {
                try
                {
                    if (!_ui.IsDisposed && _ui.IsHandleCreated) _ui.BeginInvoke(action);
                }
                catch { }
            }

            public void LaunchWindow()
            {
                // While the server is still starting the window would only show an error page;
                // OnPoll opens it as soon as the server answers.
                if (_shuttingDown || _waitingForServer) return;
                if (!_useWebView)
                {
                    StartDashboard(_edgePath, _edgeProfileDir);
                    return;
                }
                if (_window == null) _window = new DashboardForm(webview2Dir, placementFile, OnCloseRequested, OnWebViewFailed);
                _window.Reveal();
            }

            /// <summary>WebView2 would not start after all: carry on with the Edge window.</summary>
            private void OnWebViewFailed(Exception ex)
            {
                Log("WebView2 failed to start, falling back to the Edge window: " + ex);
                Post(() =>
                {
                    _useWebView = false;
                    DashboardForm failed = _window;
                    _window = null;
                    if (failed != null) failed.CloseForGood();
                    LaunchWindow();
                });
            }

            /// <summary>
            /// Fallback window only. Edge holds "lockfile" in its profile folder open for as long as
            /// any window of that profile is open, and deletes it on exit. Watching it catches the
            /// real close, whatever process Edge hands the window to.
            /// </summary>
            private bool IsEdgeWindowOpen()
            {
                string lockPath = Path.Combine(_edgeProfileDir, "lockfile");
                if (!File.Exists(lockPath)) return false;
                try
                {
                    using (new FileStream(lockPath, FileMode.Open, FileAccess.Read, FileShare.None)) { }
                    return false; // stale: nobody holds it
                }
                catch (IOException) { return true; }
                catch { return false; }
            }

            private void OnPoll()
            {
                if (_shuttingDown) return;
                if (_waitingForServer)
                {
                    if (!IsPortOpen("127.0.0.1", SERVER_PORT, 200) || !IsOurServer()) return;
                    _waitingForServer = false;
                    _trayIcon.Text = "SessionManagerPro";
                    Log("Server answered after a slow start; opening the dashboard.");
                    LaunchWindow();
                    return;
                }
                if (!_useWebView)
                {
                    bool open = IsEdgeWindowOpen();
                    if (_windowWasOpen && !open) OnEdgeWindowClosed();
                    _windowWasOpen = open;
                }

                // A server we didn't start (e.g. `npm start`) raises no Exited event; watch its port.
                if (_nodeProcess == null && ++_ticks % 3 == 0)
                {
                    _portMisses = IsPortOpen("127.0.0.1", SERVER_PORT, 300) ? 0 : _portMisses + 1;
                    if (_portMisses >= 2) OnServerExited();
                }
            }

            /// <summary>
            /// The user (or the panel's Quit) closes the dashboard window. True: let it go (hidden);
            /// false: keep it open. "tray" always keeps running; "quit" quits, but first asks when
            /// profiles are running: keep them running in the tray, stop them and quit, or cancel.
            /// </summary>
            private bool OnCloseRequested()
            {
                if (_shuttingDown) return true;
                // "Quit" in the panel closes the window once the server is gone: that's an exit,
                // not a close-to-tray. Posted: the window is still inside its own closing event.
                if (!IsPortOpen("127.0.0.1", SERVER_PORT, 300))
                {
                    Post(OnServerExited);
                    return true;
                }
                string behavior = ReadCloseBehavior();
                Log("Dashboard window closed; close behavior = " + behavior);
                if (behavior == "tray")
                {
                    ToldAboutTray();
                    return true;
                }
                int running = RunningCount();
                CloseChoice choice = running == 0 ? CloseChoice.Quit : CloseDialog.Ask(_window, running, true);
                Log("Close choice: " + choice + " (" + running + " running)");
                if (choice == CloseChoice.Cancel) return false;
                if (choice == CloseChoice.Tray) ToldAboutTray();
                else Shutdown();
                return true;
            }

            /// <summary>Fallback window: Edge already closed it, so Cancel opens it again.</summary>
            private void OnEdgeWindowClosed()
            {
                if (!OnCloseRequested()) LaunchWindow();
            }

            /// <summary>The tray's Quit: confirm first when profiles are running.</summary>
            private void QuitFromTray()
            {
                if (_shuttingDown) return;
                int running = IsPortOpen("127.0.0.1", SERVER_PORT, 300) ? RunningCount() : 0;
                if (running != 0 && CloseDialog.Ask(_window, running, false) != CloseChoice.Quit) return;
                Shutdown();
            }

            /// <summary>Once per run: say where the app went.</summary>
            private void ToldAboutTray()
            {
                if (_toldAboutTray) return;
                _toldAboutTray = true;
                _trayIcon.ShowBalloonTip(
                    4000,
                    "SessionManagerPro is still running",
                    "Profiles keep working in the background. Click the tray icon to open it again, or right-click it to quit.",
                    ToolTipIcon.Info);
            }

            private void OnServerExited()
            {
                if (_shuttingDown) return;
                int code = 0;
                try { if (_nodeProcess != null) code = _nodeProcess.ExitCode; } catch { }
                Log("Server exited with code " + code);
                if (code != 0)
                {
                    MessageBox.Show(
                        "The SessionManagerPro server stopped unexpectedly (exit code " + code + ").\nSee updates/server.log for details.",
                        "SessionManagerPro", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
                FinishExit();
            }

            /// <summary>Graceful quit: browsers close and save cookies before the server exits.</summary>
            public void Shutdown()
            {
                if (_shuttingDown) return;
                _shuttingDown = true;
                Log("Quit requested.");
                _trayIcon.Text = "SessionManagerPro — closing browsers…";
                if (_window != null) _window.Hide();

                // Off the UI thread: saving cookies across many browsers can take tens of seconds,
                // and a frozen tray looks hung to Windows and to a second launch.
                ThreadPool.QueueUserWorkItem(_ =>
                {
                    bool asked = RequestServerQuit();
                    if (_nodeProcess != null && !_nodeProcess.HasExited)
                    {
                        // Give each browser time to save its cookies; force only as a last resort.
                        if (!asked || !_nodeProcess.WaitForExit(30000)) KillServerIfRunning();
                    }
                    Post(FinishExit);
                });
            }

            private void FinishExit()
            {
                _shuttingDown = true;
                _poll.Stop();
                _showWait.Unregister(null);
                _showEvent.Dispose();
                if (_window != null)
                {
                    _window.CloseForGood();
                    _window = null;
                }
                _trayIcon.Visible = false;
                _trayIcon.Dispose();
                ExitThread();
            }

            private void KillServerIfRunning()
            {
                try
                {
                    if (_nodeProcess != null && !_nodeProcess.HasExited)
                    {
                        Log("Stopping Node server process (PID: " + _nodeProcess.Id + ")...");
                        _nodeProcess.Kill();
                    }
                }
                catch { }
            }
        }

        private static bool IsPortOpen(string host, int port, int timeoutMs)
        {
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    IAsyncResult ar = client.BeginConnect(host, port, null, null);
                    bool connected = ar.AsyncWaitHandle.WaitOne(timeoutMs);
                    if (connected)
                    {
                        client.EndConnect(ar);
                        return true;
                    }
                    return false;
                }
            }
            catch
            {
                return false;
            }
        }

        /// <summary>The bundled runtime first, then a system Node. Null when there is none.</summary>
        private static string FindNodeExecutable()
        {
            string[] candidates = new string[]
            {
                Path.Combine(baseDir, "runtime", "node", "node.exe"),
                @"C:\Program Files\nodejs\node.exe",
                @"C:\Program Files (x86)\nodejs\node.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\node\node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), @"npm\node.exe")
            };

            foreach (string path in candidates)
            {
                if (File.Exists(path)) return path;
            }

            try
            {
                Process p = Process.Start(new ProcessStartInfo
                {
                    FileName = "where.exe",
                    Arguments = "node",
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    RedirectStandardOutput = true
                });
                string output = p.StandardOutput.ReadLine();
                p.WaitForExit();
                if (!string.IsNullOrEmpty(output) && File.Exists(output.Trim()))
                {
                    return output.Trim();
                }
            }
            catch { }

            return null;
        }

        private static string FindEdgeExecutable()
        {
            string[] paths = new string[]
            {
                @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\Edge\Application\msedge.exe"),
                @"C:\Program Files\Google\Chrome\Application\chrome.exe",
                @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
            };

            foreach (string p in paths)
            {
                if (File.Exists(p)) return p;
            }
            return null;
        }
    }
}
