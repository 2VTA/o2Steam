using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Text.Json;
using Microsoft.Win32;

ApplicationConfiguration.Initialize();

// --selftest <folder>: runs Install then Uninstall against a fake Steam folder, with no windows and
// without touching a running Steam. Used to check the installer logic.
var selfTest = Array.IndexOf(args, "--selftest");
if (selfTest >= 0 && selfTest + 1 < args.Length)
{
    var form = new InstallerForm();
    return await form.SelfTest(args[selfTest + 1]);
}

// --install <steam folder> / --uninstall <steam folder>: the same install or removal without windows
// (Steam must already be closed). Handy for scripted tests.
foreach (var mode in new[] { "--install", "--uninstall" })
{
    var at = Array.IndexOf(args, mode);
    if (at >= 0 && at + 1 < args.Length)
        return await new InstallerForm().RunSilent(args[at + 1], mode == "--install");
}

Application.Run(new InstallerForm());
return 0;

// What the installer puts where. The payload zip holds these names; Millennium's build puts the
// libraries in <steam>\millennium\lib, the helper programs in <steam>\millennium\bin, and a copy of the
// bootstrap as <steam>\wsock32.dll (the file Steam loads, which in turn loads the rest).
record PayloadFile(string ZipName, string DestRelative);

record InstallManifest(string Version, string InstalledAt, string BackupDir, List<string> Files);

sealed class InstallerForm : Form
{
    private const string Version = "0.2.0";
    private const string ManifestName = "o2steam-install.json";

    private static readonly PayloadFile[] Payload =
    {
        new("lib/millennium.dll", @"millennium\lib\millennium.dll"),
        new("lib/millennium.hhx64.dll", @"millennium\lib\millennium.hhx64.dll"),
        new("lib/millennium.bootstrap64.dll", @"millennium\lib\millennium.bootstrap64.dll"),
        new("bin/millennium.crashhandler64.exe", @"millennium\bin\millennium.crashhandler64.exe"),
        new("bin/millennium.luavm64.exe", @"millennium\bin\millennium.luavm64.exe"),
        new("root/wsock32.dll", "wsock32.dll"),
    };

    private static readonly string LogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "o2steam", "installer.log");

    private readonly TextBox steamPath = new();
    private readonly Label statusLine = new();
    private readonly RichTextBox log = new();
    private readonly Button installButton = new();
    private readonly Button uninstallButton = new();
    private bool silent;

    public InstallerForm()
    {
        Text = $"o2steam Installer {Version}";
        Width = 860;
        Height = 640;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(15, 20, 28);
        ForeColor = Color.FromArgb(220, 230, 240);
        Font = new Font("Segoe UI", 10f);

        var icon = LoadEmbedded("o2steam.ico");
        if (icon is not null) Icon = new Icon(icon);

        var logoStream = LoadEmbedded("o2steam-logo.png");
        var logo = new PictureBox
        {
            Dock = DockStyle.Top,
            Height = 150,
            SizeMode = PictureBoxSizeMode.Zoom,
            BackColor = Color.Black,
            Image = logoStream is null ? null : Image.FromStream(logoStream),
        };

        var intro = new Label
        {
            Dock = DockStyle.Top,
            Height = 58,
            Padding = new Padding(16, 10, 16, 0),
            Text = "Installs o2steam (a Millennium fork) into your Steam folder. Steam is closed during the install, and anything it replaces is backed up so Uninstall can bring it back.",
        };

        var pathRow = new TableLayoutPanel { Dock = DockStyle.Top, Height = 52, ColumnCount = 3, Padding = new Padding(16, 8, 16, 8) };
        pathRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 80));
        pathRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        pathRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 110));
        pathRow.Controls.Add(new Label { Text = "Steam folder", Anchor = AnchorStyles.Left, AutoSize = true }, 0, 0);
        steamPath.Dock = DockStyle.Fill;
        steamPath.BackColor = Color.FromArgb(27, 40, 56);
        steamPath.ForeColor = Color.White;
        steamPath.BorderStyle = BorderStyle.FixedSingle;
        steamPath.TextChanged += (_, _) => RefreshState();
        pathRow.Controls.Add(steamPath, 1, 0);
        var browse = StyledButton("Browse...");
        browse.Click += (_, _) =>
        {
            using var dialog = new FolderBrowserDialog { Description = "Pick your Steam folder (the one with steam.exe)" };
            if (dialog.ShowDialog(this) == DialogResult.OK) steamPath.Text = dialog.SelectedPath;
        };
        pathRow.Controls.Add(browse, 2, 0);

        statusLine.Dock = DockStyle.Top;
        statusLine.Height = 30;
        statusLine.Padding = new Padding(16, 4, 16, 0);
        statusLine.ForeColor = Color.FromArgb(102, 192, 244);

        var buttons = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 58, Padding = new Padding(16, 8, 16, 8) };
        installButton.Text = "Install / Update";
        uninstallButton.Text = "Uninstall";
        StyleButton(installButton, primary: true);
        StyleButton(uninstallButton, primary: false);
        installButton.Click += async (_, _) => await RunAsync(Install);
        uninstallButton.Click += async (_, _) => await RunAsync(Uninstall);
        buttons.Controls.Add(installButton);
        buttons.Controls.Add(uninstallButton);

        log.Dock = DockStyle.Fill;
        log.ReadOnly = true;
        log.BackColor = Color.FromArgb(10, 14, 20);
        log.ForeColor = Color.FromArgb(170, 200, 225);
        log.BorderStyle = BorderStyle.None;
        log.Font = new Font("Consolas", 9.5f);

        Controls.Add(log);
        Controls.Add(buttons);
        Controls.Add(statusLine);
        Controls.Add(pathRow);
        Controls.Add(intro);
        Controls.Add(logo);

        steamPath.Text = DetectSteam() ?? "";
        RefreshState();
        Write($"o2steam installer {Version}");
    }

    // ---------------------------------------------------------------- steam / state

    private static string? DetectSteam()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam");
            var path = key?.GetValue("SteamPath") as string;
            if (!string.IsNullOrWhiteSpace(path))
            {
                var full = Path.GetFullPath(path.Replace('/', '\\'));
                if (File.Exists(Path.Combine(full, "steam.exe"))) return full;
            }
        }
        catch { }

        foreach (var guess in new[] { @"C:\Program Files (x86)\Steam", @"C:\Program Files\Steam" })
            if (File.Exists(Path.Combine(guess, "steam.exe"))) return guess;
        return null;
    }

    private string Root => steamPath.Text.Trim().Trim('"');
    private bool SteamFolderOk => Root.Length > 0 && File.Exists(Path.Combine(Root, "steam.exe"));
    private string ManifestPath => Path.Combine(Root, "millennium", ManifestName);

    private void RefreshState()
    {
        var ok = SteamFolderOk;
        installButton.Enabled = ok;
        uninstallButton.Enabled = ok && File.Exists(ManifestPath);
        if (!ok) statusLine.Text = "Can't find steam.exe in that folder.";
        else if (File.Exists(ManifestPath)) statusLine.Text = "o2steam is installed here. Install again to update, or Uninstall.";
        else statusLine.Text = "Ready. o2steam is not installed here yet.";
    }

    private static bool SteamRunning() =>
        Process.GetProcessesByName("steam").Length > 0 || Process.GetProcessesByName("steamwebhelper").Length > 0;

    private async Task CloseSteamAsync()
    {
        if (!SteamRunning()) return;

        Write("Steam is running - asking it to shut down...");
        try
        {
            Process.Start(new ProcessStartInfo(Path.Combine(Root, "steam.exe"), "-shutdown") { UseShellExecute = false, CreateNoWindow = true });
        }
        catch (Exception e) { Write("  (shutdown request failed: " + e.Message + ")"); }

        for (var i = 0; i < 40 && SteamRunning(); i++) await Task.Delay(500);

        if (SteamRunning())
        {
            Write("Steam did not close by itself - ending its processes.");
            foreach (var name in new[] { "steamwebhelper", "steam", "steamservice" })
                foreach (var p in Process.GetProcessesByName(name))
                {
                    try { p.Kill(true); } catch { }
                }
            await Task.Delay(1500);
        }

        if (SteamRunning()) throw new InvalidOperationException("Steam is still running. Close it and try again.");
        Write("Steam is closed.");
    }

    // ---------------------------------------------------------------- install / uninstall

    public async Task<int> RunSilent(string folder, bool install)
    {
        silent = true;
        steamPath.Text = folder;
        try
        {
            if (SteamRunning()) throw new InvalidOperationException("Steam is running - close it first.");
            if (install) await Install(); else await Uninstall();
            return 0;
        }
        catch (Exception e) { Console.WriteLine("FAILED: " + e.Message); return 1; }
    }

    public async Task<int> SelfTest(string folder)
    {
        silent = true;
        Directory.CreateDirectory(Path.Combine(folder, "millennium", "lib"));
        if (!File.Exists(Path.Combine(folder, "steam.exe"))) File.WriteAllText(Path.Combine(folder, "steam.exe"), "fake");
        File.WriteAllText(Path.Combine(folder, "wsock32.dll"), "ORIGINAL-wsock32");
        steamPath.Text = folder;

        await Install();
        var ok = File.Exists(ManifestPath)
                 && File.Exists(Path.Combine(folder, "millennium", "lib", "millennium.dll"))
                 && new FileInfo(Path.Combine(folder, "wsock32.dll")).Length > 1000;
        Console.WriteLine("install ok: " + ok);

        var extrasOk = File.Exists(Path.Combine(folder, "millennium", "themes", "o2-retro", "skin.json"))
                       && File.ReadAllText(Path.Combine(folder, "millennium", "themes", "o2-retro", "skin.json")).Contains("o2Restyle")
                       && File.Exists(Path.Combine(folder, "millennium", "plugins", "o2-avatars", "plugin.json"))
                       && File.Exists(Path.Combine(folder, "millennium", "plugins", "o2-trade-stack", ".millennium", "Dist", "webkit.js"));
        var cfgText = File.ReadAllText(Path.Combine(folder, "millennium", "config", "config.json"));
        extrasOk = extrasOk && cfgText.Contains("o2-avatars") && cfgText.Contains("o2-trade-stack") && cfgText.Contains("\"activeTheme\": \"o2-retro\"");
        Console.WriteLine("extras ok: " + extrasOk);
        ok = ok && extrasOk;

        await Uninstall();
        var restored = File.ReadAllText(Path.Combine(folder, "wsock32.dll")) == "ORIGINAL-wsock32"
                       && !File.Exists(Path.Combine(folder, "millennium", "lib", "millennium.dll"))
                       && !File.Exists(ManifestPath)
                       && !File.Exists(Path.Combine(folder, "millennium", "themes", "o2-retro", "skin.json"));
        Console.WriteLine("uninstall restored original: " + restored);
        return ok && restored ? 0 : 1;
    }

    private async Task RunAsync(Func<Task> action)
    {
        installButton.Enabled = uninstallButton.Enabled = false;
        try { await action(); }
        catch (Exception e)
        {
            Write("FAILED: " + e.Message);
            MessageBox.Show(this, e.Message, "o2steam", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally { RefreshState(); }
    }

    private async Task Install()
    {
        if (!SteamFolderOk) throw new InvalidOperationException("Pick the Steam folder first.");

        if (!silent && SteamRunning())
        {
            var answer = MessageBox.Show(this, "Steam has to be closed to install o2steam. Close it now?", "o2steam", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (answer != DialogResult.Yes) { Write("Cancelled - Steam was left running."); return; }
        }
        if (!silent) await CloseSteamAsync();

        var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        var backupDir = Path.Combine(Root, "millennium", "o2steam-backup", stamp);
        var installed = new List<string>();

        using var payloadStream = LoadEmbedded("o2steam.zip") ?? throw new InvalidOperationException("The installer has no payload inside.");
        using var zip = new ZipArchive(payloadStream, ZipArchiveMode.Read);

        foreach (var file in Payload)
        {
            // Windows PowerShell's Compress-Archive writes backslashes in entry names, so compare with both
            var entry = zip.Entries.FirstOrDefault(e => e.FullName.Replace("\\", "/") == file.ZipName)
                        ?? throw new InvalidOperationException("Payload is missing " + file.ZipName);
            var dest = Path.Combine(Root, file.DestRelative);
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);

            if (File.Exists(dest))
            {
                var backup = Path.Combine(backupDir, file.DestRelative);
                Directory.CreateDirectory(Path.GetDirectoryName(backup)!);
                File.Copy(dest, backup, overwrite: true);
                Write("Backed up " + file.DestRelative);
            }

            entry.ExtractToFile(dest, overwrite: true);
            installed.Add(file.DestRelative);
            Write("Installed " + file.DestRelative);
        }

        // the o2 Retro Terminal theme and the o2steam plugins ride along in the payload under extras/
        // (extras/themes/<name>/... and extras/plugins/<name>/...) and land in the millennium folder of Steam
        foreach (var entry in zip.Entries)
        {
            var name = entry.FullName.Replace("\\", "/");
            if (!name.StartsWith("extras/") || name.EndsWith("/")) continue;

            var rel = Path.Combine("millennium", name.Substring("extras/".Length).Replace('/', Path.DirectorySeparatorChar));
            var dest = Path.Combine(Root, rel);
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);

            if (File.Exists(dest))
            {
                var backup = Path.Combine(backupDir, rel);
                Directory.CreateDirectory(Path.GetDirectoryName(backup)!);
                File.Copy(dest, backup, overwrite: true);
            }

            entry.ExtractToFile(dest, overwrite: true);
            installed.Add(rel);
        }
        Write("Installed the o2 Retro Terminal theme and the o2steam plugins.");
        EnableExtras();

        var manifest = new InstallManifest(Version, DateTime.Now.ToString("s"), Directory.Exists(backupDir) ? backupDir : "", installed);
        File.WriteAllText(ManifestPath, JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true }));
        Write("Done. Start Steam - o2steam loads with it.");

        if (!silent && MessageBox.Show(this, "o2steam is installed. Start Steam now?", "o2steam", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
            Process.Start(new ProcessStartInfo(Path.Combine(Root, "steam.exe")) { UseShellExecute = true });
    }

    // Turns the bundled plugins on and, when the user has no theme chosen, picks the bundled one.
    // Anything the user already chose is left as it is.
    private void EnableExtras()
    {
        try
        {
            var path = Path.Combine(Root, "millennium", "config", "config.json");
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var root = File.Exists(path) ? System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(path)) as System.Text.Json.Nodes.JsonObject : null;
            root ??= new System.Text.Json.Nodes.JsonObject();

            var plugins = root["plugins"] as System.Text.Json.Nodes.JsonObject ?? new System.Text.Json.Nodes.JsonObject();
            var enabled = plugins["enabledPlugins"] as System.Text.Json.Nodes.JsonArray ?? new System.Text.Json.Nodes.JsonArray();
            foreach (var name in new[] { "o2-avatars", "o2-trade-stack" })
                if (!enabled.Any(n => n?.GetValue<string>() == name)) enabled.Add(name);
            plugins["enabledPlugins"] = enabled;
            root["plugins"] = plugins;

            var themes = root["themes"] as System.Text.Json.Nodes.JsonObject ?? new System.Text.Json.Nodes.JsonObject();
            var active = themes["activeTheme"]?.GetValue<string>();
            if (string.IsNullOrEmpty(active) || active == "default") themes["activeTheme"] = "o2-retro";
            root["themes"] = themes;

            File.WriteAllText(path, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            Write("Turned on the o2steam plugins" + (themes["activeTheme"]?.GetValue<string>() == "o2-retro" ? " and the o2 Retro Terminal theme." : "."));
        }
        catch (Exception e)
        {
            Write("Could not update the settings (turn the plugins on from Plugins in o2steam): " + e.Message);
        }
    }

    private async Task Uninstall()
    {
        if (!File.Exists(ManifestPath)) throw new InvalidOperationException("o2steam isn't installed in this folder.");

        var manifest = JsonSerializer.Deserialize<InstallManifest>(File.ReadAllText(ManifestPath))
                       ?? throw new InvalidOperationException("The install record is unreadable.");

        if (!silent && SteamRunning())
        {
            var answer = MessageBox.Show(this, "Steam has to be closed to remove o2steam. Close it now?", "o2steam", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (answer != DialogResult.Yes) { Write("Cancelled - Steam was left running."); return; }
        }
        if (!silent) await CloseSteamAsync();

        foreach (var rel in manifest.Files)
        {
            var dest = Path.Combine(Root, rel);
            if (File.Exists(dest)) { File.Delete(dest); Write("Removed " + rel); }

            if (manifest.BackupDir.Length > 0)
            {
                var backup = Path.Combine(manifest.BackupDir, rel);
                if (File.Exists(backup))
                {
                    File.Copy(backup, dest, overwrite: true);
                    Write("Restored " + rel);
                }
            }
        }

        File.Delete(ManifestPath);
        Write("o2steam is removed. Your settings, themes and plugins were left alone.");
    }

    // ---------------------------------------------------------------- small helpers

    private static Stream? LoadEmbedded(string name) =>
        Assembly.GetExecutingAssembly().GetManifestResourceStream(name);

    private void Write(string line)
    {
        void Append()
        {
            log.AppendText(line + Environment.NewLine);
            log.ScrollToCaret();
        }
        if (InvokeRequired) Invoke(Append); else Append();

        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
            File.AppendAllText(LogPath, $"{DateTime.Now:s} {line}{Environment.NewLine}");
        }
        catch { }
    }

    private static Button StyledButton(string text)
    {
        var b = new Button { Text = text, Dock = DockStyle.Fill };
        StyleButton(b, primary: false);
        return b;
    }

    private static void StyleButton(Button b, bool primary)
    {
        b.FlatStyle = FlatStyle.Flat;
        b.FlatAppearance.BorderSize = 1;
        b.FlatAppearance.BorderColor = Color.FromArgb(102, 192, 244);
        b.BackColor = primary ? Color.FromArgb(102, 192, 244) : Color.FromArgb(27, 40, 56);
        b.ForeColor = primary ? Color.FromArgb(15, 20, 28) : Color.FromArgb(220, 230, 240);
        b.Height = 38;
        b.Width = 170;
        b.Cursor = Cursors.Hand;
    }
}
