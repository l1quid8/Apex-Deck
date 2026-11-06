use crate::{
    input::clean,
    state::{mention, AppState},
};
use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};
use unicode_width::UnicodeWidthChar;
pub const CYAN: Color = Color::Rgb(103, 232, 249);
pub const MINT: Color = Color::Rgb(82, 243, 163);
pub const GRAY: Color = Color::Rgb(148, 163, 184);
const MARK_CYAN: Color = Color::Rgb(38, 215, 239);
const WORD_WHITE: Color = Color::Rgb(245, 252, 248);

// Pixel copies of public/branding/mark.svg (diamond, mint top, cyan bottom,
// `>_` prompt) and the logo-horizontal.svg wordmark. g = mint, c = cyan,
// # = white. Two pixel rows share one terminal row through half blocks.
const MARK_LARGE: [&str; 25] = [
    "            g            ",
    "           ggg           ",
    "          gg gg          ",
    "         gg   gg         ",
    "        gg     gg        ",
    "       gg       gg       ",
    "      gg         gg      ",
    "     gg           gg     ",
    "    gg             gg    ",
    "   gg   gg          gg   ",
    "  gg     gg          gg  ",
    " gg       gg          gg ",
    "cc         gg          cc",
    " cc       gg          cc ",
    "  cc     gg          cc  ",
    "   cc   gg    ccccc cc   ",
    "    cc             cc    ",
    "     cc           cc     ",
    "      cc         cc      ",
    "       cc       cc       ",
    "        cc     cc        ",
    "         cc   cc         ",
    "          cc cc          ",
    "           ccc           ",
    "            c            ",
];
const MARK_SMALL: [&str; 17] = [
    "        g        ",
    "       g g       ",
    "      g   g      ",
    "     g     g     ",
    "    g       g    ",
    "   g         g   ",
    "  g  g        g  ",
    " g    g        g ",
    "c      g        c",
    " c    g        c ",
    "  c  g  cccc  c  ",
    "   c         c   ",
    "    c       c    ",
    "     c     c     ",
    "      c   c      ",
    "       c c       ",
    "        c        ",
];
const WORDMARK: [&str; 8] = [
    "   ##     ######   #######  ##    ##     ######   #######   ######  ##   ##",
    "  ####    ##   ##  #######   ##  ##      ##   ##  #######  ##       ##  ## ",
    "  #  #    ##   ##  ##         ####       ##    #  ##       ##       ## ##  ",
    " ##  ##   ##   ##  ######      ##        ##    #  ######   ##       ####   ",
    " ##  ##   ######   ######     ####       ##    #  ######   ##       ####   ",
    " ######   ##       ##        ##  ##      ##    #  ##       ##       ## ##  ",
    "##    ##  ##       #######  ##    ##     ##   ##  #######  ##       ##  ## ",
    "##    ##  ##       #######  ##    ##     ######   #######   ######  ##   ##",
];

fn pixel(c: u8) -> Option<Color> {
    match c {
        b'g' => Some(MINT),
        b'c' => Some(MARK_CYAN),
        b'#' => Some(WORD_WHITE),
        _ => None,
    }
}
fn half_blocks(rows: &[&str]) -> Vec<Vec<Span<'static>>> {
    rows.chunks(2)
        .map(|pair| {
            let top = pair[0].as_bytes();
            let bottom = pair.get(1).map_or(&[][..], |r| r.as_bytes());
            let mut spans: Vec<Span<'static>> = vec![];
            let mut run = String::new();
            let mut run_style = Style::default();
            for x in 0..top.len().max(bottom.len()) {
                let t = top.get(x).copied().and_then(pixel);
                let b = bottom.get(x).copied().and_then(pixel);
                let (ch, style) = match (t, b) {
                    (Some(t), Some(b)) if t == b => ('█', Style::default().fg(t)),
                    (Some(t), Some(b)) => ('▀', Style::default().fg(t).bg(b)),
                    (Some(t), None) => ('▀', Style::default().fg(t)),
                    (None, Some(b)) => ('▄', Style::default().fg(b)),
                    (None, None) => (' ', Style::default()),
                };
                if style != run_style && !run.is_empty() {
                    spans.push(Span::styled(std::mem::take(&mut run), run_style));
                }
                run_style = style;
                run.push(ch);
            }
            if !run.is_empty() {
                spans.push(Span::styled(run, run_style));
            }
            spans
        })
        .collect()
}
const TAGLINE: &str = "Your agents. One workspace.";
/// Welcome logo sized to the screen: full mark + pixel wordmark, small mark +
/// text, or a single line. Leaves at least 10 rows for recent threads.
fn logo_lines(width: u16, height: u16) -> Vec<Line<'static>> {
    let indent = || Span::raw("  ");
    if width >= 108 && height >= 23 {
        let words = half_blocks(&WORDMARK);
        return half_blocks(&MARK_LARGE)
            .into_iter()
            .enumerate()
            .map(|(row, mark)| {
                let mut spans = vec![indent()];
                spans.extend(mark);
                spans.push(Span::raw("    "));
                match row {
                    4..=7 => spans.extend(words[row - 4].clone()),
                    9 => spans.push(Span::styled(TAGLINE, Style::default().fg(GRAY))),
                    _ => {}
                }
                Line::from(spans)
            })
            .collect();
    }
    if width >= 50 && height >= 19 {
        return half_blocks(&MARK_SMALL)
            .into_iter()
            .enumerate()
            .map(|(row, mark)| {
                let mut spans = vec![indent()];
                spans.extend(mark);
                spans.push(Span::raw("   "));
                match row {
                    3 => spans.push(Span::styled(
                        "A P E X   D E C K",
                        Style::default().fg(WORD_WHITE).add_modifier(Modifier::BOLD),
                    )),
                    5 => spans.push(Span::styled(TAGLINE, Style::default().fg(GRAY))),
                    _ => {}
                }
                Line::from(spans)
            })
            .collect();
    }
    vec![Line::from(vec![
        indent(),
        Span::styled("◆ ", Style::default().fg(MINT).add_modifier(Modifier::BOLD)),
        Span::styled(
            "APEX DECK",
            Style::default().fg(WORD_WHITE).add_modifier(Modifier::BOLD),
        ),
    ])]
}
fn safe(s: &str) -> String {
    clean(s)
}
pub fn visual_position(text: &str, width: u16) -> (u16, u16) {
    editor_layout(text, width).1
}
pub fn editor_layout(text: &str, width: u16) -> (String, (u16, u16)) {
    let width = usize::from(width.max(1));
    let (mut x, mut y) = (0usize, 0usize);
    let mut wrapped = String::new();
    for c in text
        .chars()
        .flat_map(|c| if c == '\t' { vec![' '; 4] } else { vec![c] })
    {
        if c == '\n' {
            wrapped.push(c);
            x = 0;
            y += 1;
            continue;
        }
        let n = c.width().unwrap_or(0);
        if n > 0 && (x == width || x + n > width) {
            wrapped.push('\n');
            x = 0;
            y += 1;
        }
        wrapped.push(c);
        x += n;
    }
    if x >= width {
        x = 0;
        y += 1;
    }
    (
        wrapped,
        (
            x.min(u16::MAX as usize) as u16,
            y.min(u16::MAX as usize) as u16,
        ),
    )
}
fn color(id: &str) -> Color {
    let colors = [
        CYAN,
        Color::Rgb(167, 139, 250),
        Color::Rgb(110, 231, 183),
        Color::Rgb(251, 191, 36),
    ];
    colors[id.bytes().fold(0usize, |s, b| s + usize::from(b)) % colors.len()]
}
pub fn draw(f: &mut Frame, s: &AppState, welcome_index: usize) -> Rect {
    let area = f.area();
    let width = area.width.saturating_sub(2).max(1);
    let (_, lines) = visual_position(&s.editor.text, width);
    let composer = (lines + 1)
        .clamp(2, 8)
        .saturating_add(2)
        .min(area.height.saturating_sub(4));
    let rows = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(composer),
        Constraint::Length(1),
    ])
    .split(area);
    f.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(" ◆ ", Style::default().fg(MINT).add_modifier(Modifier::BOLD)),
            Span::styled(
                "APEX DECK ",
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(safe(&s.title()), Style::default().fg(GRAY)),
        ])),
        rows[0],
    );
    f.render_widget(
        Paragraph::new(" F1 Welcome   Chat   F3 Threads   F4 Agents   F2 Requests")
            .style(Style::default().fg(GRAY)),
        rows[1],
    );
    let screen = rows[2];
    if s.view == 0 {
        let mut lines = vec![Line::from("")];
        lines.extend(logo_lines(screen.width, screen.height));
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            "  Recent threads",
            Style::default().fg(CYAN),
        )));
        lines.push(Line::from(""));
        for (i, row) in s.threads.iter().take(3).enumerate() {
            lines.push(Line::from(Span::styled(
                format!(
                    "  {} {}",
                    if i == welcome_index { "›" } else { " " },
                    safe(&row.title)
                ),
                Style::default().fg(if i == welcome_index {
                    CYAN
                } else {
                    Color::White
                }),
            )));
        }
        if s.threads.is_empty() {
            lines.push(Line::from(
                "  No threads yet. /new creates an empty thread.",
            ));
        }
        lines.extend([
            Line::from(""),
            Line::from("  / for commands · @ to pick an agent · Esc to stop"),
        ]);
        if !s.notice.is_empty() {
            lines.push(Line::from(""));
            for line in safe(&s.notice).lines() {
                lines.push(Line::from(format!("  {line}")));
            }
        }
        f.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), screen);
    } else {
        let mut lines: Vec<Line<'static>> = vec![];
        if s.view == 3 {
            lines.push(Line::from("Agents · ★ answers untagged messages next"));
            let stars = s
                .current()
                .and_then(|v| v["untagged_responders"].as_array());
            if stars.is_none() {
                lines.push(Line::from("Responder state unavailable from this daemon."));
            }
            for p in s.members() {
                let id = p["id"].as_str().unwrap_or("");
                lines.push(Line::from(Span::styled(
                    format!(
                        "{}{}  @{}  {}  {}",
                        safe(p["display_name"].as_str().unwrap_or(id)),
                        if stars.is_some_and(|stars| stars.contains(&p["id"])) {
                            " ★"
                        } else {
                            ""
                        },
                        mention(&p),
                        safe(p["backend"]["model"].as_str().unwrap_or("default model")),
                        safe(s.activity.get(id).map(String::as_str).unwrap_or(
                            if s.working().iter().any(|w| w == id) { "working…" } else { "idle" }
                        ))
                    ),
                    Style::default().fg(color(id)),
                )));
            }
        } else {
            let snapshot = s.snapshot();
            for message in snapshot["transcript"].as_array().into_iter().flatten() {
                let id = message["speaker"]["id"].as_str().unwrap_or("user");
                let name = if message["speaker"]["kind"] == "human" {
                    "user".into()
                } else {
                    s.members()
                        .iter()
                        .find(|p| p["id"] == id)
                        .and_then(|p| p["display_name"].as_str())
                        .unwrap_or(id)
                        .to_string()
                };
                lines.push(Line::from(Span::styled(
                    safe(&name),
                    Style::default()
                        .fg(if id == "user" { GRAY } else { color(id) })
                        .add_modifier(Modifier::BOLD),
                )));
                for line in safe(message["text"].as_str().unwrap_or("")).lines() {
                    lines.push(Line::from(line.to_string()));
                }
                lines.push(Line::from(""));
            }
            let working = s.working();
            for p in s.members() {
                let id = p["id"].as_str().unwrap_or("");
                if let Some(stream) = s.streams.get(id) {
                    lines.push(Line::from(Span::styled(
                        safe(p["display_name"].as_str().unwrap_or(id)),
                        Style::default().fg(color(id)),
                    )));
                    for line in safe(stream).lines() {
                        lines.push(Line::from(line.to_string()));
                    }
                }
                if working.iter().any(|w| w == id) {
                    let activity = s.activity.get(id).map(String::as_str).unwrap_or("working…");
                    lines.push(Line::from(Span::styled(
                        format!(
                            "◌ {} · {}",
                            safe(p["display_name"].as_str().unwrap_or(id)),
                            safe(activity)
                        ),
                        Style::default().fg(Color::Yellow),
                    )));
                }
            }
            if lines.is_empty() {
                lines.push(Line::from("Empty thread. /add an agent to start."));
            }
        }
        if !s.notice.is_empty() {
            lines.push(Line::from(""));
            for line in safe(&s.notice).lines() {
                lines.push(Line::from(Span::styled(
                    line.to_string(),
                    Style::default().fg(GRAY),
                )));
            }
        }
        let paragraph = Paragraph::new(lines).wrap(Wrap { trim: false });
        let total = paragraph.line_count(screen.width);
        let end = total.saturating_sub(usize::from(screen.height));
        let start = s.history.borrow_mut().start(end).min(u16::MAX as usize) as u16;
        f.render_widget(paragraph.scroll((start, 0)), screen);
    }
    let responders = s
        .current()
        .and_then(|v| v["untagged_responders"].as_array())
        .map(|stars| {
            s.members()
                .into_iter()
                .filter(|p| stars.contains(&p["id"]))
                .map(|p| p["display_name"].as_str().unwrap_or("Agent").to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let names = responders
        .iter()
        .take(3)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let suffix = if responders.len() > 3 {
        format!(" +{}", responders.len() - 3)
    } else {
        String::new()
    };
    let title = if s.connected {
        format!(
            " Message{}{}{} · @ to switch · / for commands ",
            if names.is_empty() { "" } else { " " },
            safe(&names),
            suffix
        )
    } else {
        " Disconnected · draft retained · reconnecting ".into()
    };
    let border = Block::default()
        .borders(Borders::ALL)
        .title(title)
        .border_style(Style::default().fg(if s.connected { CYAN } else { GRAY }));
    let inner = border.inner(rows[3]);
    f.render_widget(border, rows[3]);
    let (x, y) = visual_position(&s.editor.text[..s.editor.cursor], inner.width);
    let offset = y.saturating_sub(inner.height.saturating_sub(1));
    f.render_widget(
        Paragraph::new(editor_layout(&s.editor.text, inner.width).0).scroll((offset, 0)),
        inner,
    );
    if inner.width > 0 && inner.height > 0 {
        f.set_cursor_position((
            inner.x + x.min(inner.width - 1),
            inner.y + y.saturating_sub(offset).min(inner.height - 1),
        ));
    }
    let status = format!(
        " {} · {} agents{} · Alt+Enter/Ctrl-J newline · Ctrl-C exit",
        if s.connected { "connected" } else { "offline" },
        s.members().len(),
        if s.busy { " · working…" } else { "" }
    );
    f.render_widget(
        Paragraph::new(status).style(Style::default().fg(GRAY)),
        rows[4],
    );
    if let Some(menu) = &s.menu {
        let height = (menu.choices.len() + 3)
            .min(14)
            .min(usize::from(screen.height)) as u16;
        let rect = Rect::new(
            screen.x,
            screen.y + screen.height.saturating_sub(height),
            screen.width,
            height,
        );
        f.render_widget(ratatui::widgets::Clear, rect);
        let selected = menu.selected.min(menu.choices.len().saturating_sub(1));
        let first = selected.saturating_sub(usize::from(height.saturating_sub(4)));
        let lines: Vec<_> = menu
            .choices
            .iter()
            .enumerate()
            .skip(first)
            .map(|(i, c)| {
                Line::from(Span::styled(
                    format!(
                        "{} {}  {}",
                        if i == selected { "›" } else { " " },
                        safe(&c.label),
                        safe(&c.detail)
                    ),
                    Style::default().fg(if i == selected { CYAN } else { GRAY }),
                ))
            })
            .collect();
        f.render_widget(
            Paragraph::new(lines).block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(safe(&menu.title)),
            ),
            rect,
        );
        return rect;
    }
    Rect::default()
}
