"""Configure the rented machine's REAL XFCE desktop before its session starts.

No web desktop, host credentials, operator UI, package installation or networking.
The gateway embeds this source inside bootstrap. Imported tests only build text.
"""
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET


TOKEN_RE = r"0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}"   # an EVM address or a base58 Solana mint


def canonical_token(token):
    """An EVM address is case-insensitive and stored lowercase; a Solana mint keeps its case."""
    t = str(token)
    return t.lower() if t.lower().startswith("0x") else t


def prop(parent, name, kind="empty", value=None):
    attrs = {"name": name, "type": kind}
    if value is not None:
        attrs["value"] = str(value).lower() if isinstance(value, bool) else str(value)
    return ET.SubElement(parent, "property", attrs)


def array(parent, name, values, kind="int"):
    p = prop(parent, name, "array")
    for value in values:
        ET.SubElement(p, "value", {"type": kind, "value": str(value)})
    return p


def xml(root):
    ET.indent(root)
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="unicode") + "\n"


def desktop_entry(name, comment, icon, arguments):
    # Arguments are fixed executable paths/flags or a strictly checked public URL.
    # Do not shell-wrap Exec; do not permit desktop field-code expansion from input.
    for arg in arguments:
        if any(char in arg for char in ['"', "`", "$", "\\", "%", "\n", "\r"]):
            raise ValueError("unsafe desktop argument")
    command = " ".join('"' + arg + '"' for arg in arguments)
    return ("[Desktop Entry]\nVersion=1.0\nType=Application\n"
            f"Name={name}\nComment={comment}\nIcon={icon}\nExec={command}\n"
            "Terminal=false\nStartupNotify=true\nCategories=Utility;\n"
            "Path=/home/agent/work\n")


def configuration(gateway, token, width, height, theme="Greybird", icons="Papirus"):
    parsed = urlsplit(gateway)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment
            or not re.fullmatch(r"https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?/?", gateway)
            or not re.fullmatch(TOKEN_RE, token)):
        raise ValueError("expected trusted public HTTPS gateway and token")
    if not (1280 <= width <= 7680 and 720 <= height <= 4320):
        raise ValueError("unsupported desktop geometry")
    if theme not in ("Greybird", "Adwaita") or icons not in ("Papirus", "Adwaita"):
        raise ValueError("unknown theme")
    scale = 2 if width >= 3000 else 1
    files = {}
    conf = ".config/xfce4/xfconf/xfce-perchannel-xml/"
    root = ET.Element("channel", {"name": "xsettings", "version": "1.0"})
    net = prop(root, "Net"); prop(net, "ThemeName", "string", theme); prop(net, "IconThemeName", "string", icons)
    xft = prop(root, "Xft")
    for name, kind, value in [("DPI", "int", 96 * scale), ("Antialias", "int", 1), ("Hinting", "int", 1), ("RGBA", "string", "rgb")]:
        prop(xft, name, kind, value)
    gtk = prop(root, "Gtk"); prop(gtk, "FontName", "string", "DejaVu Sans 11")
    files[conf + "xsettings.xml"] = xml(root)

    root = ET.Element("channel", {"name": "xfce4-desktop", "version": "1.0"})
    screen = prop(prop(root, "backdrop"), "screen0")
    # Xvfb commonly reports 'screen'; modern xfdesktop versions also use monitor0.
    for monitor_name in ("monitorscreen", "monitor0"):
        workspace = prop(prop(screen, monitor_name), "workspace0")
        prop(workspace, "image-style", "int", 5)
        prop(workspace, "last-image", "string", "/usr/share/backgrounds/gateway.png")
    prop(prop(root, "desktop-icons"), "style", "int", 0)
    files[conf + "xfce4-desktop.xml"] = xml(root)

    root = ET.Element("channel", {"name": "xfwm4", "version": "1.0"})
    general = prop(root, "general")
    for name, kind, value in [("theme", "string", "Greybird" if theme == "Greybird" else "Default"),
                              ("title_font", "string", "DejaVu Sans Bold 11"),
                              ("use_compositing", "bool", False), ("workspace_count", "int", 1)]:
        prop(general, name, kind, value)
    array(general, "workspace_names", ["Autonom"], "string")
    files[conf + "xfwm4.xml"] = xml(root)

    root = ET.Element("channel", {"name": "xfce4-panel", "version": "1.0"})
    prop(root, "configver", "int", 2)
    panels = array(root, "panels", [1, 2])
    for number, position, length, size, plugin_ids in [
            (1, "p=6;x=0;y=0", 100, 28 * scale, [1, 2, 3]),
            (2, "p=10;x=0;y=0", 1, 48 * scale, [11, 12, 13, 14])]:
        p = prop(panels, "panel-" + str(number))
        for name, kind, value in [("position", "string", position), ("length", "uint", length),
                                  ("length-adjust", "bool", True), ("position-locked", "bool", True),
                                  ("size", "uint", size), ("icon-size", "uint", (32 if number == 2 else 16) * scale),
                                  ("autohide-behavior", "uint", 0)]:
            prop(p, name, kind, value)
        array(p, "plugin-ids", plugin_ids)
    plugins = prop(root, "plugins")
    tasklist = prop(plugins, "plugin-1", "string", "tasklist")
    prop(tasklist, "grouping", "uint", 1); prop(tasklist, "show-labels", "bool", True)
    separator = prop(plugins, "plugin-2", "string", "separator")
    prop(separator, "expand", "bool", True); prop(separator, "style", "uint", 0)
    clock = prop(plugins, "plugin-3", "string", "clock")
    prop(clock, "digital-format", "string", "%a %d %b  %H:%M UTC")
    prop(clock, "timezone", "string", "UTC")

    # Kurt is a native CPU-rendered application, never the public token page.
    chrome = ["google-chrome", "--no-sandbox", "--no-first-run", "--disable-dev-shm-usage", "--disable-session-crashed-bubble", f"--force-device-scale-factor={scale}"]
    apps = [
        (11, "gateway-kurt.desktop", "Kurt", "Your Autonom community companion", "face-smile",
         ["/usr/bin/python3", "/opt/gateway-agent/desktop-kurt.py", "--gateway", gateway.rstrip("/"), "--token", canonical_token(token)]),
        (12, "gateway-browser.desktop", "Chrome", "Web browser", "google-chrome",
         chrome + ["--user-data-dir=/home/agent/.config/gateway-browser", "--new-window", "about:blank"]),
        (13, "gateway-files.desktop", "Work Files", "Open this agent's working directory", "system-file-manager", ["thunar", "/home/agent/work"]),
        (14, "gateway-editor.desktop", "Text Editor", "Create and edit text files", "accessories-text-editor", ["mousepad"]),
    ]
    for plugin_id, filename, name, comment, icon, args in apps:
        launcher = prop(plugins, "plugin-" + str(plugin_id), "string", "launcher")
        array(launcher, "items", [filename], "string")
        entry = desktop_entry(name, comment, icon, args)
        files[f".config/xfce4/panel/launcher-{plugin_id}/{filename}"] = entry
        files[".local/share/applications/" + filename] = entry
        if plugin_id == 11:
            files[".config/autostart/" + filename] = entry + "X-GNOME-Autostart-enabled=true\nOnlyShowIn=XFCE;\n"
    files[conf + "xfce4-panel.xml"] = xml(root)
    files[".config/gtk-3.0/gtk.css"] = """/* Native XFCE panels, not browser UI. */
.xfce4-panel { background-color: #f8f5ef; color: #403b3b; border: 1px solid #e4ddd4; }
#XfcePanelWindowWrapper-2 { border-radius: 18px; }
.xfce4-panel button { border-radius: 12px; padding: 8px; }
.xfce4-panel button:hover { background-color: #f0e9df; }
.xfce4-panel button:checked { background-color: #eee0dc; color: #ad2027; }
tooltip { background-color: #f8f5ef; color: #403b3b; }
"""
    root = ET.Element("channel", {"name": "xfce4-session", "version": "1.0"})
    prop(prop(root, "general"), "SaveOnExit", "bool", False)
    files[conf + "xfce4-session.xml"] = xml(root)
    return files


def install(root, files):
    """Write only fixed config outputs; refuse symlinked parent directories."""
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise ValueError("invalid desktop home")
    for relative, content in files.items():
        path = Path(relative)
        if path.is_absolute() or ".." in path.parts or path.parts[0] not in (".config", ".local"):
            raise ValueError("invalid desktop output")
        parent = root
        for part in path.parts[:-1]:
            parent /= part
            if parent.is_symlink():
                raise ValueError("symlinked desktop output")
            parent.mkdir(exist_ok=True)
        target = root / path
        if target.is_symlink():
            raise ValueError("symlinked desktop file")
        with tempfile.NamedTemporaryFile(mode="w", dir=parent, prefix=".gateway-desktop-", delete=False, encoding="utf8") as f:
            tmp = Path(f.name)
            f.write(content)
        os.chmod(tmp, 0o644)
        os.replace(tmp, target)


if __name__ == "__main__":
    gateway, token, width, height = sys.argv[1:]
    theme = "Greybird" if Path("/usr/share/themes/Greybird").is_dir() else "Adwaita"
    icons = "Papirus" if Path("/usr/share/icons/Papirus").is_dir() else "Adwaita"
    install("/home/agent", configuration(gateway, token, int(width), int(height), theme, icons))
