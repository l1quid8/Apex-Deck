#!/usr/bin/python3
"""Drive the installed Apex Deck UI over AT-SPI for the Linux CI job.

Run as the test user with DISPLAY and DBUS_SESSION_BUS_ADDRESS set.

  ui-driver.py wait-window [--timeout 120]
  ui-driver.py approve --marker PATH [--timeout 180]
  ui-driver.py deny    --marker PATH [--timeout 180]
  ui-driver.py dump                     # accessible tree to stdout (debugging)

Packages (Ubuntu 24.04): python3-gi gir1.2-atspi-2.0 python3-pyatspi at-spi2-core
(only gi + the Atspi typelib are used; pyatspi is not imported).

Accessibility prerequisites, as the test user, BEFORE the broker starts the UI
(the broker clears the app's environment, so ACCESSIBILITY_ENABLED=1 cannot be
used; Chromium falls back to asking the session bus):

  # the user's systemd/dbus session must be up (loginctl enable-linger USER),
  # then turn on the AT-SPI "IsEnabled" flag that Chromium reads at startup:
  busctl --user set-property org.a11y.Bus /org/a11y/bus org.a11y.Status IsEnabled b true
  # equivalent, persistent when dconf is installed:
  #   gsettings set org.gnome.desktop.interface toolkit-accessibility true

How Chromium (Electron 44) behaves, as observed locally:
  * With IsEnabled false the app never registers on the accessibility bus.
  * With IsEnabled true it registers, but the window's subtree stays empty
    (the frame's child is a null reference) until an assistive technology
    calls get_attributes / get_relation_set on one of its objects; Chromium
    then enables full web accessibility. This script does that itself
    (see `activate`), so no screen reader is needed.
"""

import argparse
import os
import subprocess
import sys
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

WINDOW = os.environ.get("APEX_UI_WINDOW", "Apex Deck Nightly")


class Failure(Exception):
    pass


# -- tree helpers ------------------------------------------------------------

def safe(call, default=None):
    try:
        return call()
    except Exception:  # AT-SPI raises GLib.Error for stale or busy objects
        return default


def name_of(node):
    return safe(node.get_name, "") or ""


def role_of(node):
    role = safe(node.get_role_name, "") or ""
    return "button" if role == "push button" else role


def children(node):
    count = safe(node.get_child_count, 0) or 0
    for index in range(count):
        child = safe(lambda: node.get_child_at_index(index))
        if child is not None:
            yield child


def states(node):
    state_set = safe(node.get_state_set)
    return state_set if state_set is not None else None


def has_state(node, state):
    state_set = states(node)
    return bool(state_set and state_set.contains(state))


def walk(node, depth=0, limit=60):
    yield node, depth
    if depth >= limit:
        return
    for child in children(node):
        yield from walk(child, depth + 1, limit)


def dump(node, out=sys.stderr, limit=60):
    for item, depth in walk(node, limit=limit):
        role, name = role_of(item), name_of(item)
        if not name and role in ("section", "panel", "static", "paragraph", "generic"):
            continue
        flags = []
        if has_state(item, Atspi.StateType.FOCUSED):
            flags.append("focused")
        if not has_state(item, Atspi.StateType.ENABLED) and role in ("push button", "button", "entry", "combo box"):
            flags.append("disabled")
        if has_state(item, Atspi.StateType.CHECKED) or has_state(item, Atspi.StateType.PRESSED):
            flags.append("on")
        print("  " * depth + f"[{role}] {name!r}" + (f" {{{','.join(flags)}}}" if flags else ""), file=out)


def apps():
    desktop = Atspi.get_desktop(0)
    return list(children(desktop))


def find_window():
    for app in apps():
        for frame in children(app):
            if role_of(frame) == "frame" and name_of(frame) == WINDOW:
                return frame
    return None


def activate(frame):
    """Make Chromium build its full accessibility tree (see header)."""
    safe(frame.get_attributes)
    safe(frame.get_relation_set)
    for child in children(frame):
        safe(child.get_attributes)


def document(frame):
    for node, _ in walk(frame, limit=12):
        if role_of(node) == "document web":
            return node
    return None


def find_all(root, role=None, name=None, contains=None, limit=80):
    found = []
    for node, _ in walk(root, limit=limit):
        if role is not None and role_of(node) not in (role if isinstance(role, tuple) else (role,)):
            continue
        text = name_of(node)
        if name is not None and text != name:
            continue
        if contains is not None and contains not in text:
            continue
        found.append(node)
    return found


def visible(node):
    return has_state(node, Atspi.StateType.SHOWING) and has_state(node, Atspi.StateType.VISIBLE)


def enabled(node):
    return has_state(node, Atspi.StateType.ENABLED) and has_state(node, Atspi.StateType.SENSITIVE)


BUTTONS = ("push button", "button", "toggle button", "menu item", "radio menu item",
           "check menu item", "radio button", "list item", "option", "link", "tab")


def click(node, what):
    """Press `node` through its AT-SPI Action interface."""
    action = safe(node.get_action_iface)
    if action is not None:
        names = [safe(lambda i=i: action.get_action_name(i), "") or "" for i in range(safe(action.get_n_actions, 0) or 0)]
        for wanted in ("click", "press", "activate", "jump", "clickAncestor", "doDefault", "select"):
            if wanted in names and safe(lambda: action.do_action(names.index(wanted)), False):
                log(f"clicked {what} via action {wanted!r}")
                return
        if names and safe(lambda: action.do_action(0), False):
            log(f"clicked {what} via action {names[0]!r}")
            return
    component = safe(node.get_component_iface)
    if component is not None and safe(lambda: component.grab_focus(), False):
        Atspi.generate_keyboard_event(0, " ", Atspi.KeySynthType.STRING)
        log(f"clicked {what} via focus + space")
        return
    raise Failure(f"could not press {what}")


def log(text):
    print(f"ui-driver: {text}", file=sys.stderr, flush=True)


class Session:
    def __init__(self, timeout):
        self.deadline = time.monotonic() + timeout
        self.frame = None

    def left(self):
        return self.deadline - time.monotonic()

    def until(self, what, probe, interval=0.5):
        last_error = None
        while True:
            try:
                value = probe()
                if value:
                    return value
            except Failure as error:
                last_error = error
            if self.left() <= 0:
                raise Failure(f"timed out waiting for {what}" + (f" ({last_error})" if last_error else ""))
            time.sleep(interval)

    def window(self):
        def probe():
            frame = find_window()
            if frame is None:
                return None
            activate(frame)
            return frame if document(frame) is not None else None
        self.frame = self.until(f"window {WINDOW!r} with web content", probe, 1.0)
        return self.frame

    def root(self):
        return document(self.frame) or self.frame

    def button(self, what, role=BUTTONS, name=None, contains=None, need_enabled=True):
        def probe():
            for node in find_all(self.root(), role=role, name=name, contains=contains):
                if visible(node) and (enabled(node) or not need_enabled):
                    return node
            return None
        return self.until(what, probe)

    def press(self, what, **match):
        click(self.button(what, **match), what)


# -- commands ------------------------------------------------------------------

def wait_window(args):
    session = Session(args.timeout)
    session.window()
    log(f"window {WINDOW!r} is up")
    return 0


def keys(text):
    Atspi.generate_keyboard_event(0, text, Atspi.KeySynthType.STRING)
    time.sleep(0.3)


def key(keysym):
    Atspi.generate_keyboard_event(keysym, None, Atspi.KeySynthType.SYM)
    time.sleep(0.3)


def chord(modifier, keysym):
    Atspi.generate_keyboard_event(modifier, None, Atspi.KeySynthType.LOCKMODIFIERS)
    time.sleep(0.1)
    key(keysym)
    Atspi.generate_keyboard_event(modifier, None, Atspi.KeySynthType.UNLOCKMODIFIERS)
    time.sleep(0.3)


def ctrl(keysym):
    chord(1 << 2, keysym)  # ControlMask


def alt(keysym):
    chord(1 << 3, keysym)  # Mod1Mask


RETURN, ESCAPE, LETTER_L, LETTER_O = 0xFF0D, 0xFF1B, 0x6C, 0x6F


def text_of(node):
    return safe(lambda: Atspi.Text.get_text(node, 0, -1), "") or ""


def active_window():
    """The focused X window's title; the GTK chooser is not on the AT-SPI bus."""
    run = subprocess.run(["xdotool", "getactivewindow", "getwindowname"], capture_output=True, text=True)
    return (run.stdout or run.stderr).strip()


def snapshot(name):
    """Evidence for the CI artifact: acceptance.sh copies /tmp/apex-acceptance-*."""
    subprocess.run(["xwd", "-root", "-silent", "-out", f"/tmp/apex-acceptance-{name}.xwd"], check=False)


def notices(session):
    texts = []
    for node in find_all(session.root(), role=("status bar", "alert", "notification")):
        text = " ".join(name_of(child) for child, _ in walk(node, limit=8) if name_of(child))
        if text:
            texts.append(text)
    return texts


def watch_notices(session, done, seconds):
    """Log every toast or alert that appears, until `done()` or `seconds` pass.
    Toasts vanish long before a timeout, so this is the only record of them."""
    seen, end = set(), time.monotonic() + seconds
    while time.monotonic() < end and not done():
        for text in notices(session):
            if text not in seen:
                seen.add(text)
                log(f"notice: {text!r}")
        time.sleep(0.4)


def project_button(session, name):
    for node in find_all(session.root(), role="button"):
        label = name_of(node)
        if (label == name or label.startswith(name + ", ")) and visible(node):
            return node
    return None


def ensure_project(session, folder):
    """Select the sidebar project for `folder`, adding it through
    Add workspace > This Mac and the GTK folder chooser when it is missing.
    The GTK dialog is not on the accessibility bus, so it is driven with
    synthesized keys: Ctrl+L, the path, then Alt+O for Open.

    Not Return: Chromium makes Cancel the folder dialog's default response
    (ui/gtk/select_file_dialog_linux_gtk.cc, CreateSelectFolderDialog), so
    Return in the location bar cancels and Electron reports `canceled`."""
    name = os.path.basename(folder.rstrip("/"))
    node = project_button(session, name)
    if node is None:
        session.press("Add workspace", role="button", name="Add workspace")
        session.press("'This Mac' in the Add a workspace menu", role="menu item", name="This Mac")
        time.sleep(2.0)  # let the GTK chooser map and take focus
        log(f"active window after 'This Mac': {active_window()!r}")
        ctrl(LETTER_L)
        keys(folder.rstrip("/") + "/")
        time.sleep(0.7)
        snapshot("chooser-typed")
        alt(LETTER_O)
        watch_notices(session, lambda: project_button(session, name), 20)
        log(f"active window after Open: {active_window()!r}")
        snapshot("after-open")
        node = session.until(f"project {name!r} in the sidebar", lambda: project_button(session, name))
    click(node, f"project {name!r}")
    return name


def new_thread(session, project):
    session.press("Threads section", role="button", name="Threads")
    session.press("'+ New' menu", role="button", contains="+ New")

    def entry():
        for node in find_all(session.root(), role=BUTTONS):
            label = name_of(node)
            if not visible(node):
                continue
            if label.startswith("Start a group chat"):
                return node
            if role_of(node) == "menu item" and label.startswith("Group chat") and project.lower() in label.lower():
                return node
        return None
    click(session.until("'Start a group chat' or the 'Group chat' menu item", entry), "new group chat")

    def target():
        for node in find_all(session.root(), role="button", contains="No agents yet"):
            label = name_of(node)
            if label.startswith("To ") and project.lower() in label.lower():
                return node
        return None
    session.until(f"an empty thread in {project!r} as the composer target", target)


def add_codex(session):
    # A thread with no agents shows only the empty state's "+ Add agents"; the
    # composer's "Add agent" chip appears once the thread has agents or entries.
    # Both open the same "Add an agent" dialog.
    def opener():
        for name in ("Add agent", "+ Add agents"):
            for node in find_all(session.root(), role="button", name=name):
                if visible(node) and enabled(node):
                    return node
        return None
    click(session.until("'Add agent' or the empty thread's '+ Add agents'", opener), "add agent")
    dialog = session.button("the 'Add an agent' dialog", role="dialog", name="Add an agent", need_enabled=False)
    codex = session.until("the Codex tool choice", lambda: next(
        (n for n in find_all(dialog, role="radio button") if "Codex" in name_of(n) and enabled(n)), None))
    if not has_state(codex, Atspi.StateType.CHECKED):
        click(codex, "Codex tool")
    session.until("Codex to be the chosen tool", lambda: has_state(codex, Atspi.StateType.CHECKED))
    # The jail only lets Ask/Edits write the project folder, where the marker lives.
    access = session.until("the Access select", lambda: next(iter(find_all(dialog, role="combo box", name="Access")), None))
    ask = session.until("the 'Ask first' option", lambda: next(iter(find_all(access, role="menu item", name="Ask first")), None))
    click(ask, "Access: Ask first")
    session.until("Access to read 'Ask first'", lambda: has_state(ask, Atspi.StateType.SELECTED))
    mention = "codex"
    for node in find_all(dialog, role="entry"):
        label = name_of(node)
        if label.startswith("Name") and "Mention as @" in label:
            mention = label.split("Mention as @", 1)[1].split()[0]
    session.press("'Add 1 agent'", role="button", name="Add 1 agent")
    session.until("the Codex agent chip in the composer", lambda: next(
        (n for n in find_all(session.root(), role="button", contains="Access: Ask") if name_of(n).startswith("Codex")), None))
    return mention


def send(session, text, marker_text):
    composer = session.button("the composer 'Message the room'", role="entry", name="Message the room")
    if not safe(lambda: Atspi.Component.grab_focus(composer), False):
        raise Failure("could not focus the composer")
    time.sleep(0.5)
    keys(text)
    session.until("the typed message in the composer", lambda: marker_text in text_of(composer))
    key(ESCAPE)  # close a mention suggestion list if one opened; keeps the draft
    session.press("Send", role="button", name="Send")
    session.until("the composer to empty after sending", lambda: text_of(composer).strip() == "")


ERRORS = ("Could not send", "Could not load the chat", "Protected provenance", "Could not add", "turn failed", "could not reply")


def card_for(session, marker):
    for panel in find_all(session.root(), role=("panel", "section", "landmark", "dialog", "alert"), contains="Allow or deny"):
        if any(marker in name_of(node) for node, _ in walk(panel, limit=8)):
            return panel
    return None


def errors(session):
    found = []
    for node in find_all(session.root(), role="static"):
        label = name_of(node)
        if any(word in label for word in ERRORS):
            found.append(label)
    return found


def run_marker(args, approve):
    marker = os.path.abspath(args.marker)
    folder = os.path.dirname(marker)
    if os.path.exists(marker):
        raise Failure(f"marker {marker} already exists before the turn")
    if not os.path.isdir(folder):
        raise Failure(f"the marker's folder {folder} does not exist; it becomes the thread's project")
    session = Session(args.timeout)
    session.window()
    project = ensure_project(session, folder)
    log(f"project {project!r} selected")
    new_thread(session, project)
    mention = add_codex(session)
    log(f"Codex added at Ask first as @{mention}")
    send(session, f"@{mention} please run @marker {marker}", marker)
    log("message sent; waiting for the approval card")

    def card():
        problems = errors(session)
        if problems:
            raise Failure("; ".join(problems))
        return card_for(session, marker)
    panel = session.until("the approval card for the marker command", card)
    choice = "Allow once" if approve else "Deny"
    button = session.until(f"{choice!r} on the card", lambda: next(
        (n for n in find_all(panel, role=BUTTONS, name=choice) if enabled(n)), None))
    click(button, choice)

    outcome = f"Marker created: {marker}" if approve else f"Marker declined: {marker}"

    def finished():
        for node in find_all(session.root(), role=("static", "paragraph")):
            label = name_of(node) or text_of(node)
            if f"Marker write FAILED for {marker}" in label:
                raise Failure(label)
            if outcome in label:
                return True
        problems = errors(session)
        if problems:
            raise Failure("; ".join(problems))
        return False
    session.until(f"Codex's reply {outcome!r}", finished)

    if approve:
        if not os.path.isfile(marker):
            raise Failure(f"the reply says created but {marker} is missing")
        with open(marker, encoding="utf-8") as handle:
            content = handle.read()
        if content != "accepted":
            raise Failure(f"{marker} holds {content!r}, expected 'accepted'")
    elif os.path.exists(marker):
        raise Failure(f"{marker} exists after Deny")
    log(f"ok: {'approved' if approve else 'denied'}; marker {'present' if approve else 'absent'}")
    return 0


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    waiting = sub.add_parser("wait-window")
    waiting.add_argument("--timeout", type=float, default=120)
    for name in ("approve", "deny"):
        cmd = sub.add_parser(name)
        cmd.add_argument("--marker", required=True)
        cmd.add_argument("--timeout", type=float, default=180)
    debug = sub.add_parser("dump")
    debug.add_argument("--timeout", type=float, default=60)
    args = parser.parse_args(argv)
    try:
        if args.command == "wait-window":
            return wait_window(args)
        if args.command == "dump":
            session = Session(args.timeout)
            session.window()
            dump(session.frame, out=sys.stdout)
            return 0
        return run_marker(args, approve=args.command == "approve")
    except Failure as error:
        log(f"FAILED: {error}")
        frame = find_window()
        if frame is not None:
            print("---- accessible tree ----", file=sys.stderr)
            dump(frame)
        else:
            print(f"---- no window {WINDOW!r}; applications: {[name_of(a) for a in apps()]}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
