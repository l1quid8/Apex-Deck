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
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};
pub const CYAN: Color = Color::Rgb(103, 232, 249);
pub const MINT: Color = Color::Rgb(82, 243, 163);
pub const GRAY: Color = Color::Rgb(148, 163, 184);
const MARK_CYAN: Color = Color::Rgb(38, 215, 239);
const WORD_WHITE: Color = Color::Rgb(245, 252, 248);
const DIM_GRAY: Color = Color::Rgb(90, 101, 117);
const BAND: Color = Color::Rgb(28, 34, 44);
const CODE: Color = Color::Rgb(253, 186, 116);
const AMBER: Color = Color::Rgb(251, 191, 36);
const DIM_MINT: Color = Color::Rgb(34, 85, 65);
const DIM_CYAN: Color = Color::Rgb(21, 76, 88);

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

fn truncate(text: &str, width: usize) -> String {
    if text.width() <= width {
        return text.into();
    }
    if width == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut used = 0;
    for c in text.chars() {
        let n = c.width().unwrap_or(0);
        if used + n > width - 1 {
            break;
        }
        out.push(c);
        used += n;
    }
    out.push('…');
    out
}

fn header(s: &AppState, width: u16) -> Line<'static> {
    let width = usize::from(width);
    let title = safe(&s.title()).replace(['\n', '\t'], " ");
    let members = s.members();
    let mut folder = s
        .current()
        .and_then(|v| v["cwd"].as_str())
        .map(safe)
        .unwrap_or_default()
        .replace(['\n', '\t'], " ");
    if let Ok(home) = std::env::var("HOME") {
        if let Some(rest) = folder.strip_prefix(&format!("{home}/")) {
            folder = format!("~/{rest}");
        }
    }
    let mut count = members.len();
    let mut thread = title.clone();
    let mut version = true;
    let mut show_folder = !folder.is_empty();
    let build = |thread: &str, count: usize, version: bool| {
        let mut spans = vec![
            Span::styled(
                " ◆ ",
                Style::default().fg(MINT).add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                "Apex Deck",
                Style::default().fg(WORD_WHITE).add_modifier(Modifier::BOLD),
            ),
        ];
        if version {
            spans.push(Span::styled(
                format!(" {}", env!("CARGO_PKG_VERSION")),
                Style::default().fg(DIM_GRAY),
            ));
        }
        spans.push(Span::styled("  ·  ", Style::default().fg(DIM_GRAY)));
        spans.push(Span::styled(
            thread.to_string(),
            Style::default().fg(WORD_WHITE),
        ));
        if !members.is_empty() {
            spans.push(Span::styled("  ·  ", Style::default().fg(DIM_GRAY)));
            for (i, p) in members.iter().take(count).enumerate() {
                if i > 0 {
                    spans.push(Span::styled(", ", Style::default().fg(DIM_GRAY)));
                }
                let id = p["id"].as_str().unwrap_or("");
                spans.push(Span::styled(
                    safe(p["display_name"].as_str().unwrap_or(id)).replace(['\n', '\t'], " "),
                    Style::default().fg(color(id)),
                ));
            }
            if members.len() > count {
                spans.push(Span::styled(
                    format!(" +{}", members.len() - count),
                    Style::default().fg(GRAY),
                ));
            }
        }
        Line::from(spans)
    };
    for step in 0..5 {
        let need = build(&thread, count, version).width()
            + if show_folder { folder.width() + 2 } else { 0 };
        if need <= width {
            break;
        }
        match step {
            0 => {
                folder = format!(
                    "…/{}",
                    folder
                        .trim_end_matches('/')
                        .rsplit('/')
                        .next()
                        .unwrap_or("")
                );
            }
            1 => count = count.min(3),
            2 => version = false,
            3 => thread = truncate(&title, title.width().saturating_sub(need - width).max(12)),
            _ => show_folder = false,
        }
    }
    let mut line = build(&thread, count, version);
    if show_folder && line.width() + folder.width() + 2 <= width {
        line.spans.push(Span::raw(
            " ".repeat(width - line.width() - folder.width() - 1),
        ));
        line.spans.push(Span::styled(
            format!("{folder} "),
            Style::default().fg(DIM_GRAY),
        ));
    }
    line
}

/// Small inline Markdown subset from the approved mockup. Incomplete markers
/// remain literal while streaming; fenced code is handled by reply_lines.
fn markdown(text: &str) -> Vec<Span<'static>> {
    let base = Style::default().fg(Color::Rgb(203, 213, 225));
    let mut spans = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        let token = rest
            .find("**")
            .map(|i| (i, "**"))
            .into_iter()
            .chain(rest.find('`').map(|i| (i, "`")))
            .min_by_key(|v| v.0);
        let Some((i, marker)) = token else {
            spans.push(Span::styled(rest.to_string(), base));
            break;
        };
        if i > 0 {
            spans.push(Span::styled(rest[..i].to_string(), base));
        }
        let after = &rest[i + marker.len()..];
        if let Some(end) = after.find(marker) {
            let style = if marker == "**" {
                Style::default().fg(WORD_WHITE).add_modifier(Modifier::BOLD)
            } else {
                base.fg(CODE)
            };
            spans.push(Span::styled(after[..end].to_string(), style));
            rest = &after[end + marker.len()..];
        } else {
            spans.push(Span::styled(marker.to_string(), base));
            rest = after;
        }
    }
    spans
}

/// Wrap styled content before adding prefixes, so every visual continuation
/// retains its indentation. Widths are terminal cells, not UTF-8 bytes.
fn wrapped(spans: Vec<Span<'static>>, width: usize) -> Vec<Line<'static>> {
    let width = width.max(2);
    let chars: Vec<_> = spans
        .iter()
        .flat_map(|s| s.content.chars().map(move |c| (c, s.style)))
        .collect();
    if chars.is_empty() {
        return vec![Line::default()];
    }
    let mut out = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let (mut end, mut used, mut space) = (start, 0, None);
        while end < chars.len() {
            let n = chars[end].0.width().unwrap_or(0);
            if used + n > width {
                break;
            }
            if chars[end].0 == ' ' && end > start {
                space = Some(end);
            }
            used += n;
            end += 1;
        }
        let cut = if end < chars.len() {
            space.unwrap_or(end)
        } else {
            end
        };
        let mut row: Vec<Span<'static>> = Vec::new();
        for &(c, style) in &chars[start..cut] {
            if let Some(last) = row.last_mut().filter(|last| last.style == style) {
                last.content.to_mut().push(c);
            } else {
                row.push(Span::styled(c.to_string(), style));
            }
        }
        out.push(Line::from(row));
        start = cut;
        if end < chars.len() {
            while start < chars.len() && chars[start].0 == ' ' {
                start += 1;
            }
        }
    }
    out
}

fn reply_lines(
    name: &str,
    id: &str,
    text: &str,
    width: u16,
    streaming: bool,
) -> Vec<Line<'static>> {
    let mut out = vec![Line::from(Span::styled(
        format!(" {}", safe(name)),
        Style::default().fg(color(id)).add_modifier(Modifier::BOLD),
    ))];
    let mut code = false;
    let text = safe(text).replace('\t', "    ");
    for raw in text.split('\n') {
        if raw.trim_start().starts_with("```") {
            code = !code;
            continue;
        }
        let spans = if code {
            vec![Span::styled(raw.to_string(), Style::default().fg(CODE))]
        } else {
            markdown(raw)
        };
        for mut line in wrapped(spans, usize::from(width.saturating_sub(5))) {
            line.spans.insert(0, Span::raw("   "));
            out.push(line);
        }
    }
    if streaming {
        if let Some(last) = out.last_mut() {
            last.spans
                .push(Span::styled("▍", Style::default().fg(color(id))));
        }
    }
    out.push(Line::default());
    out
}

fn human_lines(text: &str, width: u16) -> Vec<Line<'static>> {
    let style = Style::default().bg(BAND);
    let blank = || Line::from(" ".repeat(usize::from(width))).style(style);
    let mut out = vec![blank()];
    let mut first = true;
    for raw in safe(text).replace('\t', "    ").split('\n') {
        for mut line in wrapped(
            vec![Span::styled(
                raw.to_string(),
                Style::default().fg(WORD_WHITE),
            )],
            usize::from(width.saturating_sub(4)),
        ) {
            line.spans.insert(
                0,
                Span::styled(
                    if first { " › " } else { "   " },
                    Style::default().fg(CYAN).add_modifier(Modifier::BOLD),
                ),
            );
            first = false;
            line.spans.push(Span::raw(
                " ".repeat(usize::from(width).saturating_sub(line.width())),
            ));
            out.push(line.style(style));
        }
    }
    out.push(blank());
    out.push(Line::default());
    out
}

fn empty_lines(s: &AppState, screen: Rect) -> Vec<Line<'static>> {
    let mut mark: Vec<Line<'static>> = if screen.height >= 29 && screen.width >= 54 {
        MARK_LARGE
            .iter()
            .map(|r| {
                Line::from(
                    r.bytes()
                        .map(|c| {
                            if c == b' ' {
                                Span::raw("  ")
                            } else {
                                Span::styled(
                                    "██",
                                    Style::default().fg(if c == b'g' {
                                        DIM_MINT
                                    } else {
                                        DIM_CYAN
                                    }),
                                )
                            }
                        })
                        .collect::<Vec<_>>(),
                )
            })
            .collect()
    } else if screen.height >= 14 && screen.width >= 17 {
        half_blocks(&MARK_SMALL)
            .into_iter()
            .map(|spans| {
                Line::from(
                    spans
                        .into_iter()
                        .map(|mut span| {
                            let dim = |c| {
                                if c == MINT {
                                    DIM_MINT
                                } else if c == MARK_CYAN {
                                    DIM_CYAN
                                } else {
                                    c
                                }
                            };
                            span.style.fg = span.style.fg.map(dim);
                            span.style.bg = span.style.bg.map(dim);
                            span
                        })
                        .collect::<Vec<_>>(),
                )
            })
            .collect()
    } else {
        vec![]
    };
    let names: Vec<_> = s
        .members()
        .iter()
        .take(3)
        .map(|p| safe(p["display_name"].as_str().unwrap_or("Agent")))
        .collect();
    let hint = if names.is_empty() {
        "/add an agent to start · @ to pick an agent".into()
    } else {
        format!(
            "{} {} here · @ to pick an agent",
            names.join(", "),
            if names.len() == 1 { "is" } else { "are" }
        )
    };
    if !mark.is_empty() {
        mark.extend([Line::default(), Line::default()]);
    }
    // Wrap hints too, so small windows keep useful text visible.
    mark.extend(wrapped(
        vec![Span::styled(hint, Style::default().fg(GRAY))],
        usize::from(screen.width),
    ));
    let top = usize::from(screen.height).saturating_sub(mark.len()) / 2;
    let mut out = vec![Line::default(); top];
    out.extend(mark.into_iter().map(|line| line.centered()));
    out
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
    f.render_widget(Paragraph::new(header(s, area.width)), rows[0]);
    f.render_widget(
        Paragraph::new(" F1 Welcome   Chat   F3 Threads   F4 Agents   F2 Requests")
            .style(Style::default().fg(DIM_GRAY)),
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
        let mut empty_chat = false;
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
                            if s.working().iter().any(|w| w == id) {
                                "working…"
                            } else {
                                "idle"
                            }
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
                let text = message["text"].as_str().unwrap_or("");
                if message["speaker"]["kind"] == "human" {
                    lines.extend(human_lines(text, screen.width));
                } else {
                    lines.extend(reply_lines(&name, id, text, screen.width, false));
                }
            }
            let working = s.working();
            for p in s.members() {
                let id = p["id"].as_str().unwrap_or("");
                if let Some(stream) = s.streams.get(id) {
                    lines.extend(reply_lines(
                        p["display_name"].as_str().unwrap_or(id),
                        id,
                        stream,
                        screen.width,
                        working.iter().any(|w| w == id),
                    ));
                }
                if working.iter().any(|w| w == id) {
                    let activity = s.activity.get(id).map(String::as_str).unwrap_or("working…");
                    let activity = vec![
                        Span::styled(" ◌ ", Style::default().fg(AMBER)),
                        Span::styled(
                            safe(p["display_name"].as_str().unwrap_or(id)),
                            Style::default().fg(color(id)).add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(
                            format!(" · {}", safe(activity).replace('\t', "    ")),
                            Style::default().fg(AMBER),
                        ),
                    ];
                    lines.extend(wrapped(activity, usize::from(screen.width)));
                }
            }
            if lines.is_empty() {
                empty_chat = true;
                lines.extend(empty_lines(s, screen));
            }
        }
        if !s.notice.is_empty() {
            lines.push(Line::from(""));
            for line in safe(&s.notice).lines() {
                lines.extend(wrapped(
                    vec![Span::styled(
                        line.replace('\t', "    "),
                        Style::default().fg(GRAY),
                    )],
                    usize::from(screen.width),
                ));
            }
        }
        if s.view != 3 && !empty_chat && lines.len() < usize::from(screen.height) {
            let mut padding = vec![Line::default(); usize::from(screen.height) - lines.len()];
            padding.append(&mut lines);
            lines = padding;
        }
        // Transcript rows are already wrapped with their continuation prefixes.
        // WordWrapper drops whitespace-only bands and may introduce extra rows.
        let paragraph = if s.view == 3 {
            Paragraph::new(lines).wrap(Wrap { trim: false })
        } else {
            Paragraph::new(lines)
        };
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
