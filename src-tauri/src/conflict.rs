//! Splits a three-way merge of a file into what needs no decision and the conflicts between the
//! two sides, for the conflict editor.
//!
//! The merge is redone by `git merge-file` from the three versions in the index, with markers
//! longer than anything in the file that looks like one, so the result can be split reliably
//! whatever the file contains and however the user's git writes conflicts.

use serde::Serialize;

use crate::git::GitResult;

/// The conflict or the working file is no longer what the editor loaded.
pub const STALE: &str = "The conflict changed since it was opened. Reload it and resolve it again.";

/// The labels the markers are written with, to tell them from text that only looks like a marker.
pub const LABELS: [&str; 3] = ["ours", "base", "theirs"];

/// A part of a merged file.
#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Segment {
    /// Text that needs no decision: unchanged, or changed by one side only.
    Common { text: String },
    /// A place both sides changed differently. `base` is the text of their common ancestor,
    /// when there is one.
    Conflict {
        ours: String,
        base: Option<String>,
        theirs: String,
    },
}

/// The length of conflict markers that can't be mistaken for a line of the given texts: git's
/// usual 7, or one more than the longest run of a marker character that starts a line.
pub fn marker_size(texts: &[&str]) -> usize {
    let longest = texts
        .iter()
        .flat_map(|text| text.lines())
        .map(|line| match line.chars().next() {
            Some(c @ ('<' | '=' | '>' | '|')) => line.chars().take_while(|&x| x == c).count(),
            _ => 0,
        })
        .max()
        .unwrap_or(0);
    longest.max(6) + 1
}

/// Splits the output of `git merge-file -p` whose markers are `size` characters long and
/// labelled with [`LABELS`]. The base part of a conflict is optional (two-way conflict style).
pub fn parse(merged: &str, size: usize) -> GitResult<Vec<Segment>> {
    let marker = |c: char, label: Option<&str>| {
        let run = c.to_string().repeat(size);
        label.map_or(run.clone(), |label| format!("{run} {label}"))
    };
    let (start, base_start, middle, end) = (
        marker('<', Some(LABELS[0])),
        marker('|', Some(LABELS[1])),
        marker('=', None),
        marker('>', Some(LABELS[2])),
    );

    enum Part {
        Common,
        Ours,
        Base,
        Theirs,
    }
    let mut segments = Vec::new();
    let mut part = Part::Common;
    let (mut common, mut ours, mut base, mut theirs) = (String::new(), String::new(), None::<String>, String::new());
    for line in merged.split_inclusive('\n') {
        let content = line.strip_suffix('\n').unwrap_or(line);
        match part {
            Part::Common if content == start => {
                if !common.is_empty() {
                    segments.push(Segment::Common {
                        text: std::mem::take(&mut common),
                    });
                }
                part = Part::Ours;
            }
            Part::Common => common.push_str(line),
            Part::Ours if content == base_start => {
                base = Some(String::new());
                part = Part::Base;
            }
            Part::Ours | Part::Base if content == middle => part = Part::Theirs,
            Part::Ours => ours.push_str(line),
            Part::Base => base.get_or_insert_default().push_str(line),
            Part::Theirs if content == end => {
                segments.push(Segment::Conflict {
                    ours: std::mem::take(&mut ours),
                    base: base.take(),
                    theirs: std::mem::take(&mut theirs),
                });
                part = Part::Common;
            }
            Part::Theirs => theirs.push_str(line),
        }
    }
    if !matches!(part, Part::Common) {
        return Err("The merged file ends in the middle of a conflict.".into());
    }
    if !common.is_empty() {
        segments.push(Segment::Common { text: common });
    }
    Ok(segments)
}

/// `git merge-file` ends every side of a conflict with a line break, so that the markers stand
/// on lines of their own. Where the file ends inside a conflict, this takes the line break away
/// again from the sides whose version doesn't end with one.
pub fn restore_final_newline(segments: &mut [Segment], full_ours: &str, full_base: Option<&str>, full_theirs: &str) {
    let Some(Segment::Conflict { ours, base, theirs }) = segments.last_mut() else {
        return;
    };
    let restore = |text: &mut String, full: &str| {
        if !full.ends_with('\n') && text.ends_with('\n') {
            text.pop();
        }
    };
    restore(ours, full_ours);
    restore(theirs, full_theirs);
    if let (Some(base), Some(full_base)) = (base, full_base) {
        restore(base, full_base);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn common(text: &str) -> Segment {
        Segment::Common { text: text.into() }
    }

    fn conflict(ours: &str, base: Option<&str>, theirs: &str) -> Segment {
        Segment::Conflict {
            ours: ours.into(),
            base: base.map(String::from),
            theirs: theirs.into(),
        }
    }

    #[test]
    fn serializes_segments_as_the_frontend_reads_them() {
        let json = serde_json::to_string(&[common("a\n"), conflict("b\n", None, "c\n")]).unwrap();
        assert_eq!(
            json,
            r#"[{"kind":"common","text":"a\n"},{"kind":"conflict","ours":"b\n","base":null,"theirs":"c\n"}]"#
        );
    }

    #[test]
    fn picks_markers_longer_than_any_line_that_looks_like_one() {
        assert_eq!(marker_size(&["plain\ntext\n", ""]), 7);
        // Shorter runs, and runs that don't start a line, are no danger.
        assert_eq!(marker_size(&["<<< here\n", "a ========== b\n"]), 7);
        assert_eq!(marker_size(&["=======\n"]), 8);
        assert_eq!(marker_size(&["text\n", "<<<<<<<<< nine\n", ">>>>>>>> eight\n"]), 10);
        assert_eq!(marker_size(&["|||||||||||| table\n"]), 13);
    }

    #[test]
    fn splits_merged_text_into_common_parts_and_conflicts() {
        let merged = "one\n<<<<<<< ours\nTWO\n||||||| base\ntwo\n=======\n2\n>>>>>>> theirs\nthree\nfour\n\
<<<<<<< ours\n||||||| base\nfive\n=======\nFIVE\nfive and a half\n>>>>>>> theirs\n";
        assert_eq!(
            parse(merged, 7).unwrap(),
            vec![
                common("one\n"),
                conflict("TWO\n", Some("two\n"), "2\n"),
                common("three\nfour\n"),
                // One side deleted the line, and nothing follows the last conflict.
                conflict("", Some("five\n"), "FIVE\nfive and a half\n"),
            ]
        );
        assert_eq!(
            parse("no conflicts\nhere", 7).unwrap(),
            vec![common("no conflicts\nhere")]
        );
        assert_eq!(parse("", 7).unwrap(), vec![]);
    }

    #[test]
    fn splits_a_conflict_without_a_base() {
        let merged = "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\nshared\n";
        assert_eq!(
            parse(merged, 7).unwrap(),
            vec![conflict("ours\n", None, "theirs\n"), common("shared\n")]
        );
    }

    #[test]
    fn keeps_lines_that_look_like_markers() {
        // The file documents conflicts itself, so the real markers are one character longer.
        assert_eq!(marker_size(&["<<<<<<< ours\n=======\nmine\n", ">>>>>>> theirs\n"]), 8);
        let merged = [
            "<<<<<<< ours",
            "<<<<<<<< ours",
            "=======",
            "mine",
            "|||||||| base",
            "=======",
            "========",
            ">>>>>>> theirs",
            ">>>>>>>> theirs",
            ">>>>>>> theirs",
            "",
        ]
        .join("\n");
        assert_eq!(
            parse(&merged, 8).unwrap(),
            vec![
                common("<<<<<<< ours\n"),
                conflict("=======\nmine\n", Some("=======\n"), ">>>>>>> theirs\n"),
                common(">>>>>>> theirs\n"),
            ]
        );
    }

    #[test]
    fn refuses_text_that_ends_inside_a_conflict() {
        let err = parse("<<<<<<< ours\nmine\n=======\n", 7).unwrap_err();
        assert!(err.contains("middle of a conflict"), "{err}");
    }

    #[test]
    fn keeps_a_missing_final_newline_of_a_side() {
        let merged = "start\n<<<<<<< ours\nours\n||||||| base\nbase\n=======\ntheirs\n>>>>>>> theirs\n";
        let mut segments = parse(merged, 7).unwrap();
        restore_final_newline(&mut segments, "start\nours", Some("start\nbase\n"), "start\ntheirs");
        assert_eq!(
            segments,
            vec![common("start\n"), conflict("ours", Some("base\n"), "theirs")]
        );

        // A file that ends after the last conflict is left alone.
        let mut segments = parse("<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\nend", 7).unwrap();
        restore_final_newline(&mut segments, "a\nend", None, "b\nend");
        assert_eq!(segments, vec![conflict("a\n", None, "b\n"), common("end")]);
    }
}
