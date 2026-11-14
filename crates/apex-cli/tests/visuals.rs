use apex_cli::{
    state::{AppState, Thread},
    ui,
};
use ratatui::{
    backend::TestBackend,
    buffer::Buffer,
    style::{Color, Modifier},
    Terminal,
};
use serde_json::{json, Value};

fn state(messages: Value) -> AppState {
    let mut s = AppState::default();
    s.select("r".into());
    s.connected = true;
    s.threads.push(Thread {
        id: "r".into(),
        title: "Settings".into(),
        updated: 0,
        kind: "work".into(),
    });
    s.install_snapshot("r", s.generation, json!({"recovery_seq":0,"cwd":"/tmp/sample/app","snapshot":{"participants":[{"id":"null","display_name":"Null"}],"transcript":messages},"active":[]}));
    s
}
fn render(s: &AppState, w: u16, h: u16) -> Buffer {
    let mut t = Terminal::new(TestBackend::new(w, h)).unwrap();
    t.draw(|f| {
        ui::draw(f, s, 0);
    })
    .unwrap();
    t.backend().buffer().clone()
}
fn row(b: &Buffer, y: u16) -> String {
    (0..b.area.width).map(|x| b[(x, y)].symbol()).collect()
}
fn text(b: &Buffer) -> String {
    (0..b.area.height)
        .map(|y| row(b, y))
        .collect::<Vec<_>>()
        .join("\n")
}
fn find(b: &Buffer, needle: &str) -> u16 {
    (0..b.area.height)
        .find(|y| row(b, *y).contains(needle))
        .unwrap_or_else(|| panic!("missing {needle}:\n{}", text(b)))
}

#[test]
fn human_turn_wraps_in_full_width_band_without_speaker_label() {
    let s =
        state(json!([{"speaker":{"kind":"human","id":"person"},"text":"first line\nsecond line"}]));
    let b = render(&s, 80, 24);
    let y = find(&b, "› first line");
    assert!(row(&b, y + 1).starts_with("   second line"));
    for band_y in y - 1..=y + 2 {
        for x in 0..80 {
            assert_eq!(
                b[(x, band_y)].bg,
                Color::Rgb(28, 34, 44),
                "at {x},{band_y} (message row {y})\n{}",
                text(&b)
            );
        }
    }
    assert!(!text(&b)
        .lines()
        .any(|l| l.trim() == "user" || l.trim() == "person"));
}

#[test]
fn replies_wrap_with_indent_and_render_inline_styles_and_code_blocks() {
    let s = state(
        json!([{"speaker":{"kind":"agent","id":"null"},"text":"**Account settings remain bold across wrapped lines with enough text to wrap twice** and `settings.tsx`.\n```rs\nlet x = 1;\n```\nunfinished **marker"}]),
    );
    let b = render(&s, 40, 30);
    let y = find(&b, "Account settings");
    assert!(row(&b, y).starts_with("   Account"));
    assert!(row(&b, y + 1).starts_with("   "));
    assert!(b[(3, y)].modifier.contains(Modifier::BOLD));
    assert!(b[(3, y + 1)].modifier.contains(Modifier::BOLD));
    assert!(!text(&b).contains("**Account") && !text(&b).contains("```"));
    let code_y = find(&b, "let x = 1;");
    assert_eq!(b[(3, code_y)].fg, Color::Rgb(253, 186, 116));
    assert!(text(&b).contains("unfinished **marker"));
}

#[test]
fn empty_mark_uses_available_space_and_disappears_for_live_output() {
    let mut s = state(json!([]));
    for (w, h, large, small) in [
        (120, 42, true, false),
        (80, 24, false, true),
        (80, 16, false, false),
        (30, 24, false, true),
    ] {
        let b = render(&s, w, h);
        let body = (2..h - 5)
            .map(|y| row(&b, y))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(body.contains("██"), large, "{w}×{h}");
        assert_eq!(body.contains('▀') || body.contains('▄'), small, "{w}×{h}");
        assert!(body.contains("@ to pick"));
    }
    s.streams.insert("null".into(), "restored **reply**".into());
    s.activity.insert("null".into(), "writing reply".into());
    let b = render(&s, 120, 42);
    assert!(text(&b).contains("   restored reply▍"));
    assert!(text(&b).contains("◌ Null · writing reply"));
    assert!(!text(&b).contains("██"));
}

#[test]
fn header_fits_long_unicode_thread_many_agents_and_workspace() {
    let mut s = state(json!([]));
    s.threads[0].title = "界 Settings and onboarding review with a very long thread name".into();
    s.rooms.get_mut("r").unwrap()["snapshot"]["participants"] = json!([
        {"id":"jigga","display_name":"Jigga"},{"id":"null","display_name":"Null"},{"id":"muck","display_name":"Muck"},
        {"id":"cast","display_name":"Cast"},{"id":"twil","display_name":"Twil"},{"id":"gronk","display_name":"Gronk"}]);
    let b = render(&s, 80, 16);
    let header = row(&b, 0);
    assert!(
        header.contains("Apex Deck") && header.contains("…") && header.contains("+3"),
        "{header}"
    );
    assert!(header.ends_with("…/app "), "{header}");
    let roomy = render(&state(json!([])), 120, 42);
    assert!(row(&roomy, 0).contains(env!("CARGO_PKG_VERSION")));
    assert!(row(&roomy, 0).ends_with("/tmp/sample/app "));
    for (w, h) in [(1, 1), (10, 4), (20, 10)] {
        render(&s, w, h);
    }
}

#[test]
fn header_drops_version_before_shortening_thread_title() {
    let mut s = state(json!([]));
    s.threads[0].title = "Keep the complete thread title here".into();
    let header = row(&render(&s, 70, 16), 0);
    assert!(
        header.contains("Keep the complete thread title here"),
        "{header}"
    );
    assert!(!header.contains(env!("CARGO_PKG_VERSION")), "{header}");
    assert!(header.ends_with("…/app "), "{header}");
}

#[test]
fn header_abbreviates_home_only_for_paths_inside_home() {
    let home = std::env::var("HOME").unwrap();
    let mut s = state(json!([]));
    s.rooms.get_mut("r").unwrap()["cwd"] = json!(format!("{home}/work/app"));
    assert!(row(&render(&s, 120, 24), 0).ends_with("~/work/app "));
    s.rooms.get_mut("r").unwrap()["cwd"] = json!(format!("{home}-other/work/app"));
    assert!(row(&render(&s, 120, 24), 0).ends_with(&format!("{home}-other/work/app ")));
}

#[test]
fn wrapped_human_rows_keep_marker_band_and_unicode_text() {
    let s = state(
        json!([{"speaker":{"kind":"human","id":"person"},"text":"界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界\n\tlast line"}]),
    );
    let b = render(&s, 40, 24);
    let y = find(&b, "› 界");
    assert!(row(&b, y + 1).starts_with("   界"));
    assert_eq!(text(&b).matches('界').count(), 30);
    for band_y in y..=y + 2 {
        for x in 0..40 {
            // Ratatui resets placeholder cells behind double-width glyphs;
            // the terminal paints both columns using the leading cell style.
            if x > 0 && unicode_width::UnicodeWidthStr::width(b[(x - 1, band_y)].symbol()) == 2 {
                continue;
            }
            assert_eq!(b[(x, band_y)].bg, Color::Rgb(28, 34, 44));
        }
    }
}

#[test]
fn mark_thresholds_follow_composer_height_and_history_removes_it() {
    let mut s = state(json!([]));
    for (height, big, half) in [
        (36, true, false),
        (35, false, true),
        (21, false, true),
        (20, false, false),
    ] {
        let b = render(&s, 80, height);
        assert_eq!(text(&b).contains("██"), big);
        assert_eq!(text(&b).contains('▀'), half);
    }
    s.editor
        .insert("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight");
    let b = render(&s, 80, 24);
    assert!(!text(&b).contains('▀'));
    assert!(text(&b).contains("eight"));
    s.editor.take();
    s.rooms.get_mut("r").unwrap()["snapshot"]["transcript"] =
        json!([{"speaker":{"kind":"human"},"text":"hello"}]);
    assert!(!text(&render(&s, 120, 42)).contains("██"));
}

#[test]
fn review_fixtures_render_real_terminal_cells() {
    let empty = state(json!([]));
    let mut busy = state(json!([
        {"speaker":{"kind":"human"},"text":"@null can you sketch a settings page for the sample app?"},
        {"speaker":{"kind":"agent","id":"null"},"text":"I would start with **Account**, **Notifications** and **Appearance**.\n\nEach section is one card in `settings.tsx`."},
        {"speaker":{"kind":"human"},"text":"sounds good. keep it to one screen\nand check the wording"}
    ]));
    busy.streams.insert(
        "null".into(),
        "**One screen**, no tabs. Here is the next section".into(),
    );
    busy.activity.insert("null".into(), "writing reply".into());
    let mut returned = state(
        json!([{"speaker":{"kind":"human"},"text":"@null @muck write onboarding copy and check the layout"}]),
    );
    returned.rooms.get_mut("r").unwrap()["snapshot"]["participants"] =
        json!([{"id":"null","display_name":"Null"},{"id":"muck","display_name":"Muck"}]);
    returned.streams.insert("null".into(),"Here is a first pass:\n\n**Step 1 · Sign in.** Pick a provider with `/login`.\n\n**Step 2 · Create agents.** Give each one a name and".into());
    returned
        .activity
        .insert("null".into(), "writing reply".into());
    returned
        .activity
        .insert("muck".into(), "running npm run lint".into());
    let mut fit = state(json!([]));
    fit.threads[0].title = "Settings and onboarding review with a very long thread name".into();
    fit.rooms.get_mut("r").unwrap()["snapshot"]["participants"] = json!([{"id":"jigga","display_name":"Jigga"},{"id":"null","display_name":"Null"},{"id":"muck","display_name":"Muck"},{"id":"cast","display_name":"Cast"},{"id":"twil","display_name":"Twil"},{"id":"gronk","display_name":"Gronk"}]);
    for (name, s, w, h) in [
        ("empty", &empty, 120, 42),
        ("busy", &busy, 120, 42),
        ("return", &returned, 120, 42),
        ("small", &empty, 80, 24),
        ("fit", &fit, 80, 16),
    ] {
        let b = render(s, w, h);
        assert!(text(&b).contains("Message"));
        if name == "return" {
            assert!(text(&b).contains("◌ Null · writing reply"));
            assert!(text(&b).contains("◌ Muck · running npm run lint"));
        }
        // Optional review artifacts contain actual rendered glyphs and colours.
        if let Ok(dir) = std::env::var("APEX_CLI_VISUAL_FIXTURES") {
            std::fs::create_dir_all(&dir).unwrap();
            let cells: Vec<_> = (0..h).flat_map(|y| (0..w).map(move |x| (x,y))).map(|(x,y)| {
                let c = &b[(x,y)];
                json!({"x":x,"y":y,"text":c.symbol(),"fg":format!("{:?}",c.fg),"bg":format!("{:?}",c.bg),"bold":c.modifier.contains(Modifier::BOLD)})
            }).collect();
            std::fs::write(
                format!("{dir}/{name}.json"),
                serde_json::to_vec(&json!({"width":w,"height":h,"cells":cells})).unwrap(),
            )
            .unwrap();
        }
    }
}

#[test]
fn short_conversation_sits_above_composer_as_in_approved_mockup() {
    let s = state(json!([{"speaker":{"kind":"agent","id":"null"},"text":"a short reply"}]));
    let b = render(&s, 80, 24);
    assert_eq!(find(&b, "a short reply"), 17);
    assert!(row(&b, 18).trim().is_empty());
    assert!(row(&b, 19).contains("Message"));
}

fn panel_state(stars: usize) -> AppState {
    let names = ["Null", "Muck", "Jigga", "Cast", "Luna", "Gronk"];
    let participants: Vec<Value> = names
        .iter()
        .map(|n| json!({"id":n.to_lowercase(),"display_name":n,"access":"ask","effort":"high","backend":{"kind":"agent","tool":"codex","model":"gpt-5.5"}}))
        .collect();
    let star_ids: Vec<Value> = names.iter().take(stars).map(|n| json!(n.to_lowercase())).collect();
    let mut s = AppState::default();
    s.select("r".into());
    s.connected = true;
    s.install_snapshot("r", s.generation, json!({"recovery_seq":0,"cwd":"/tmp/app","untagged_responders":star_ids,"snapshot":{"kind":"work","participants":participants,"transcript":[{"speaker":{"kind":"human","id":"p"},"text":"hello"}],"usage":{"null":{"input":12400,"output":3100,"turns":7}}},"active":[]}));
    s
}
fn widths_fit(b: &Buffer) {
    use unicode_width::UnicodeWidthStr;
    for y in 0..b.area.height {
        let line = row(b, y);
        assert!(line.trim_end().width() <= usize::from(b.area.width), "row {y} too wide: {line}");
    }
}

#[test]
fn settings_panel_matches_v6_at_both_sizes() {
    use apex_cli::settings;
    for (w, h) in [(120u16, 40u16), (80, 24)] {
        let mut s = panel_state(2);
        settings::toggle(&mut s);
        let b = render(&s, w, h);
        widths_fit(&b);
        let title = find(&b, " Null this thread");
        assert!(row(&b, title).contains("1 of 6 · Tab next"), "{}", text(&b));
        assert!(row(&b, title + 1).contains("Model") && row(&b, title + 1).contains("◂  gpt-5.5  ▸"));
        assert!(row(&b, title + 2).starts_with(" ▸ Reasoning"), "focus starts on Reasoning");
        assert!(row(&b, title + 3).contains("Speed") && row(&b, title + 3).contains("default"));
        assert!(row(&b, title + 4).contains("Access") && row(&b, title + 4).contains("Ask"));
        assert!(row(&b, title + 5).contains("This thread · 12.4k in · 3.1k out · 7 turns"));
        assert!(row(&b, title + 6).contains("←→ change · ↑↓ row · Esc close"));
        // Panel sits directly above the message box; focused value is cyan.
        assert!(row(&b, title + 7).starts_with('┌'));
        let x = row(&b, title + 2).find(" high ").map(|i| row(&b, title + 2)[..i].chars().count()).unwrap() as u16;
        assert_eq!(b[(x + 1, title + 2)].bg, Color::Rgb(103, 232, 249));
        assert_ne!(b[(x + 1, title + 1)].bg, Color::Rgb(103, 232, 249), "only the focused value is highlighted");
        assert!(row(&b, h - 1).trim_end().ends_with("⇧Tab settings"));
    }
}

#[test]
fn settings_footer_states_fit_at_80_columns() {
    use apex_cli::settings::{self, Row};
    let mut s = panel_state(2);
    settings::open(&mut s, Some(Row::Access), Some("muck".into()));
    s.settings.as_mut().unwrap().pending_access = Some("full".into());
    let b = render(&s, 80, 24);
    widths_fit(&b);
    assert!(text(&b).contains("Enter applies Full · now Ask · Esc cancels"), "{}", text(&b));
    assert!(text(&b).contains("◂  Full  ▸"), "pending choice shows in the row");
    s.settings.as_mut().unwrap().confirm_full = true;
    for width in [40, 80, 120] {
        let b = render(&s, width, 24);
        widths_fit(&b);
        let shown = text(&b).split_whitespace().collect::<Vec<_>>().join(" ");
        let warning = format!("Muck {} Enter yes · Esc no", settings::full_access_warning());
        assert!(shown.contains(&warning), "the complete warning and both choices must remain visible at {width} columns:\n{}", text(&b));
    }
    s.settings.as_mut().unwrap().confirm_full = false;
    s.settings.as_mut().unwrap().pending_access = None;
    s.settings.as_mut().unwrap().row = Some(Row::Reasoning);
    settings::begin_save(&mut s, "muck", Row::Reasoning);
    let b = render(&s, 80, 24);
    let y = find(&b, "Reasoning");
    assert!(row(&b, y).contains("◂  high  ▸  saving…"));
    s.saves.clear();
    s.settings.as_mut().unwrap().error = Some("no participant with the id `muck` is in this chat".into());
    let b = render(&s, 80, 24);
    let y = find(&b, "no participant");
    let x = row(&b, y).find("no participant").unwrap() as u16;
    assert_eq!(b[(x, y)].fg, Color::Rgb(248, 113, 113), "errors are the only red");
}

#[test]
fn bottom_line_keeps_shortcut_with_six_star_agents() {
    let s = panel_state(6);
    let b = render(&s, 80, 24);
    widths_fit(&b);
    let last = row(&b, 23);
    assert!(last.trim_end().ends_with("⇧Tab settings"), "{last}");
    assert!(last.contains("★ Null"));
    assert!(last.contains("★"));
    let s = panel_state(6);
    let b = render(&s, 40, 24);
    let last = row(&b, 23);
    assert!(last.trim_end().ends_with("⇧Tab settings"), "{last}");
    assert!(last.contains("+"), "names that don't fit fold into +N: {last}");
}
