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
