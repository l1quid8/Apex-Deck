//! Lifecycle rules shared by private facts and project notes.
use std::collections::BTreeSet;

pub(crate) fn current(
    deleted_at: Option<u64>,
    superseded_by: Option<&str>,
    expires_at: Option<u64>,
    now: u64,
) -> bool {
    deleted_at.is_none() && superseded_by.is_none() && expires_at.is_none_or(|at| at > now)
}

/// Any member may be forgotten; erase both older and newer corrections.
pub(crate) fn correction_chain<'a>(
    id: &str,
    links: impl Iterator<Item = (&'a str, Option<&'a str>)>,
) -> BTreeSet<String> {
    let links: Vec<_> = links.collect();
    let mut chain = BTreeSet::from([id.to_owned()]);
    loop {
        let before = chain.len();
        for (from, to) in &links {
            if chain.contains(*from) || to.is_some_and(|to| chain.contains(to)) {
                chain.insert((*from).to_owned());
                if let Some(to) = to {
                    chain.insert((*to).to_owned());
                }
            }
        }
        if chain.len() == before {
            return chain;
        }
    }
}
