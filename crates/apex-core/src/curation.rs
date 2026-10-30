//! Shared, reversible context visibility. Transcript positions remain untouched.
use serde::{Deserialize, Serialize};
use crate::ParticipantId;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Curation {
    pub by: ParticipantId,
    pub at: usize,
    pub hidden: Vec<[usize; 2]>,
    pub reason: String,
    pub when: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undone: Option<u64>,
}
impl Curation { pub fn count(&self) -> usize { self.hidden.iter().map(|[a,b]| b.saturating_sub(*a).saturating_add(1)).sum() } }
pub fn stands(curations: &[Curation]) -> bool { curations.iter().any(|c| c.undone.is_none()) }
pub fn merge_ranges(numbers: impl IntoIterator<Item=usize>) -> Vec<[usize;2]> {
    let mut numbers: Vec<_> = numbers.into_iter().collect(); numbers.sort_unstable(); numbers.dedup();
    let mut ranges: Vec<[usize;2]> = vec![];
    for n in numbers { match ranges.last_mut() { Some([_,b]) if b.saturating_add(1) == n => *b=n, _=>ranges.push([n,n]) } }
    ranges
}
pub fn contains(ranges: &[[usize;2]], n: usize) -> bool { ranges.iter().any(|[a,b]| *a<=n && n<=*b) }
pub fn hidden_line([a,b]: [usize;2]) -> String {
    if a==b { format!("[#{a} hidden, 1 message]") } else { format!("[#{a}–#{b} hidden, {} messages]",b-a+1) }
}
pub fn keep_valid(curations: Vec<Curation>, len: usize) -> Vec<Curation> {
    curations.into_iter().filter(|c| c.at<=len && !c.hidden.is_empty() && c.hidden.iter().all(|[a,b]| a<=b && *b<c.at)
        && c.hidden.windows(2).all(|pair| pair[0][1].checked_add(1).is_some_and(|n| n<pair[1][0]))).collect()
}

use crate::{Message, ParticipantConfig, Speaker};
pub const KEEP_NEWEST: usize = 20;
pub const HEAD_CHARS: usize = 120;
pub const TAIL_CHARS: usize = 120;
pub const HUMAN_CHARS: usize = 2_000;
pub const CONTEXT_CHARS: usize = 12_000;
pub const DIGEST_CHARS: usize = 60_000;
pub const REQUEST_CHARS: usize = 64_000;
pub const OUTPUT_CHARS: usize = 4_000;
pub const REASON_CHARS: usize = 160;
pub const CURATE_WORKING: &str = "Choosing what to hide";
pub const CURATE_SYSTEM: &str = "You help tidy a long group chat between a human and several AI models. \
Every model rereads the chat on each turn, so old messages that no longer matter waste its time. \
Nothing is deleted: hidden messages stay in the human's chat and the models can look them up, \
but a model won't look for something it doesn't know is there. \
Pick older messages the models no longer need: finished work, test output, dead ends, small talk. \
Keep what the human asked for and still wants, decisions, open questions, and exact values still in use. \
Use the recent messages to judge what still matters. \
A long message shows only its length, start and end, so hide one only if those make it clear it is finished. \
If you are unsure, keep it. You have no tools. Reply with one JSON object and nothing else: \
{\"hide\":[\"120-340\",\"355\"],\"reason\":\"one short line\"}. \
Reply {\"hide\":[],\"reason\":\"\"} if nothing is worth hiding.";

pub struct Picks { pub hidden: Vec<[usize; 2]>, pub reason: String }
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag="status", rename_all="snake_case")]
pub enum CurateOutcome { Hidden { count: usize, unchecked: usize }, Nothing { unchecked: usize }, Stopped }
pub fn offerable(message: &Message) -> bool { message.speaker != Speaker::Human || message.text.chars().count()<=HUMAN_CHARS }
fn one_line(text: &str) -> String { text.split_whitespace().collect::<Vec<_>>().join(" ") }
fn excerpt(message: &Message, roster: &[ParticipantConfig]) -> String {
    let name=match &message.speaker { Speaker::Human=>"Human", Speaker::Bot(id)=>crate::view::display_name(id,roster) };
    let size=message.text.chars().count();
    let body=if message.speaker != Speaker::Human && size>HEAD_CHARS+TAIL_CHARS {
        let head: String=message.text.chars().take(HEAD_CHARS).collect();
        let tail: String=message.text.chars().skip(size-TAIL_CHARS).collect();
        format!("({size} chars) {} … {}",one_line(&head),one_line(&tail))
    } else {one_line(&message.text)};
    format!("#{} [{name}] {body}\n",message.seq)
}
pub fn digest(transcript: &[Message], candidates: &[usize], summary: Option<&str>, roster: &[ParticipantConfig], budget: usize) -> (String, Vec<usize>) {
    let budget=budget.min(DIGEST_CHARS);
    let context_budget=CONTEXT_CHARS.min(budget/3);
    let mut context=String::from("Where the chat is now. These messages stay visible.\n\n");
    if let Some(summary)=summary {context.push_str("Summary of earlier messages: ");context.extend(summary.chars().take(context_budget/2));context.push('\n');}
    for message in transcript.iter().skip(transcript.len().saturating_sub(KEEP_NEWEST)) {
        let line=excerpt(message,roster);let left=context_budget.saturating_sub(context.chars().count());
        if left<=32 {break;}
        if line.chars().count()>left {context.extend(line.chars().take(left-24));context.push_str(" … [context clipped]\n");break;}
        context.push_str(&line);
    }
    context.push_str("\nOlder messages you may hide, oldest first.\n\n");
    let mut size=context.chars().count();let mut offered=vec![];
    for &seq in candidates {
        let Some(message)=transcript.get(seq).filter(|m|m.seq==seq && offerable(m)) else {continue;};
        let line=excerpt(message,roster);let len=line.chars().count();
        if size+len+140>budget {break;}
        context.push_str(&line);size+=len;offered.push(seq);
    }
    let left=candidates.len().saturating_sub(offered.len());
    if left>0 {context.push_str(&format!("({left} newer messages were left out of this list and stay visible.)\n"));}
    if context.chars().count()>budget {return (String::new(),vec![]);}
    (context,offered)
}
pub fn parse_picks(reply: &str, offered: &[usize]) -> Result<Picks,String> {
    let start=reply.find('{').ok_or("missing object")?;
    let mut stream=serde_json::Deserializer::from_str(&reply[start..]).into_iter::<serde_json::Value>();
    let object=stream.next().ok_or("missing object")?.map_err(|e|e.to_string())?;
    let list=object.get("hide").and_then(|v|v.as_array()).ok_or("missing hide list")?;
    // Intersect intervals with offered IDs; never expand a model-supplied range.
    let mut ranges=vec![];
    for item in list {
        if let Some(n)=item.as_u64().and_then(|n|usize::try_from(n).ok()) {ranges.push([n,n]);continue;}
        let Some(s)=item.as_str() else {continue;};
        let s=s.replace('#',"").replace('–',"-");let mut parts=s.split('-');
        let Some(a)=parts.next().and_then(|s|s.trim().parse::<usize>().ok()) else {continue;};
        let b=match parts.next(){Some(s)=>match s.trim().parse::<usize>() {Ok(n)=>n,Err(_)=>continue},None=>a};
        if parts.next().is_none() && a<=b {ranges.push([a,b]);}
    }
    let hidden=merge_ranges(offered.iter().copied().filter(|n|contains(&ranges,*n)));
    let reason=one_line(object.get("reason").and_then(|v|v.as_str()).unwrap_or("")).chars().take(REASON_CHARS).collect();
    Ok(Picks{hidden,reason})
}
pub(crate) fn now() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d|d.as_millis() as u64).unwrap_or(0) }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CurationUndo { pub restored: usize, pub sealed: usize }
