//! Commit graph lane layout.
//!
//! Commits arrive newest first (children before parents). We keep a list of
//! "lanes", each waiting for a specific commit to appear. Every row is described
//! by line segments the frontend can draw independently, which keeps rendering
//! cheap and lets the list be virtualized.

use serde::Serialize;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Half {
    /// From the top edge of the row (at `from`) to the commit dot height (at `to`).
    Top,
    /// From the commit dot height (at `from`) to the bottom edge of the row (at `to`).
    Bottom,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub from: usize,
    pub to: usize,
    pub half: Half,
    pub color: usize,
}

#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    /// Lane (column) of the commit dot.
    pub col: usize,
    pub color: usize,
    /// Number of lanes this row needs to render.
    pub width: usize,
    pub segments: Vec<Segment>,
}

struct Lane {
    sha: String,
    color: usize,
}

fn free_slot(lanes: &mut Vec<Option<Lane>>) -> usize {
    match lanes.iter().position(Option::is_none) {
        Some(i) => i,
        None => {
            lanes.push(None);
            lanes.len() - 1
        }
    }
}

pub fn layout<'a>(commits: impl Iterator<Item = (&'a str, &'a [String])>) -> Vec<GraphRow> {
    let mut lanes: Vec<Option<Lane>> = Vec::new();
    let mut next_color = 0usize;
    let mut rows = Vec::new();

    for (sha, parents) in commits {
        let expecting: Vec<usize> = lanes
            .iter()
            .enumerate()
            .filter(|(_, l)| l.as_ref().is_some_and(|l| l.sha == sha))
            .map(|(i, _)| i)
            .collect();

        let (col, color) = match expecting.first() {
            Some(&i) => (i, lanes[i].as_ref().unwrap().color),
            None => {
                // A branch tip nobody has seen yet: it starts a new lane.
                let i = free_slot(&mut lanes);
                next_color += 1;
                (i, next_color - 1)
            }
        };

        let mut segments = Vec::new();

        // Upper half: lanes coming in from the row above.
        for (i, lane) in lanes.iter().enumerate() {
            if let Some(lane) = lane {
                let to = if lane.sha == sha { col } else { i };
                segments.push(Segment {
                    from: i,
                    to,
                    half: Half::Top,
                    color: lane.color,
                });
            }
        }
        let width_before = lanes.len();

        for &i in &expecting {
            lanes[i] = None;
        }

        // Lanes this commit continues into.
        let mut new_lanes = Vec::new();
        let mut merge_into_existing = Vec::new();
        if let Some(first) = parents.first() {
            lanes[col] = Some(Lane {
                sha: first.clone(),
                color,
            });
        }
        for parent in parents.iter().skip(1) {
            let existing = lanes.iter().position(|l| l.as_ref().is_some_and(|l| &l.sha == parent));
            match existing {
                Some(i) => merge_into_existing.push(i),
                None => {
                    let i = free_slot(&mut lanes);
                    lanes[i] = Some(Lane {
                        sha: parent.clone(),
                        color: next_color,
                    });
                    next_color += 1;
                    new_lanes.push(i);
                }
            }
        }

        // Lower half: lanes going out to the row below.
        for (i, lane) in lanes.iter().enumerate() {
            if let Some(lane) = lane {
                let from = if i == col || new_lanes.contains(&i) { col } else { i };
                segments.push(Segment {
                    from,
                    to: i,
                    half: Half::Bottom,
                    color: lane.color,
                });
            }
        }
        for &i in &merge_into_existing {
            let color = lanes[i].as_ref().unwrap().color;
            segments.push(Segment {
                from: col,
                to: i,
                half: Half::Bottom,
                color,
            });
        }

        let width = width_before.max(lanes.len()).max(col + 1);
        while matches!(lanes.last(), Some(None)) {
            lanes.pop();
        }

        rows.push(GraphRow {
            col,
            color,
            width,
            segments,
        });
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(commits: &[(&str, &[&str])]) -> Vec<GraphRow> {
        let owned: Vec<(String, Vec<String>)> = commits
            .iter()
            .map(|(s, p)| (s.to_string(), p.iter().map(|x| x.to_string()).collect()))
            .collect();
        layout(owned.iter().map(|(s, p)| (s.as_str(), p.as_slice())))
    }

    #[test]
    fn linear_history_stays_in_one_lane() {
        let rows = run(&[("c", &["b"]), ("b", &["a"]), ("a", &[])]);
        assert!(rows.iter().all(|r| r.col == 0 && r.width == 1));
        assert!(rows[2].segments.iter().all(|s| s.half == Half::Top));
    }

    #[test]
    fn merge_opens_and_closes_a_lane() {
        // m merges b2 into a2; both branch off a1.
        let rows = run(&[("m", &["a2", "b2"]), ("b2", &["a1"]), ("a2", &["a1"]), ("a1", &[])]);
        assert_eq!(rows[0].col, 0);
        assert!(rows[0].segments.contains(&Segment {
            from: 0,
            to: 1,
            half: Half::Bottom,
            color: rows[1].color
        }));
        assert_eq!(rows[1].col, 1);
        assert_eq!(rows[2].col, 0);
        // a1 is expected by both lanes, so both converge into it.
        assert_eq!(rows[3].col, 0);
        assert!(
            rows[3]
                .segments
                .iter()
                .any(|s| s.from == 1 && s.to == 0 && s.half == Half::Top)
        );
    }

    #[test]
    fn sibling_branch_tips_get_their_own_lanes_and_converge() {
        let rows = run(&[("b", &["a"]), ("c", &["a"]), ("a", &[])]);
        assert_eq!((rows[0].col, rows[1].col, rows[2].col), (0, 1, 0));
        assert_ne!(rows[0].color, rows[1].color);
        // c starts a new lane, so nothing enters its row from above.
        assert!(!rows[1].segments.iter().any(|s| s.half == Half::Top && s.to == 1));
        assert!(
            rows[2]
                .segments
                .iter()
                .any(|s| s.half == Half::Top && s.from == 1 && s.to == 0)
        );
        assert_eq!(rows[2].width, 2);
    }

    #[test]
    fn first_parent_keeps_the_branch_color() {
        let rows = run(&[("c", &["b"]), ("b", &["a"]), ("a", &[])]);
        assert!(rows.iter().all(|r| r.color == rows[0].color));
    }

    #[test]
    fn octopus_merge_opens_one_lane_per_extra_parent() {
        let rows = run(&[
            ("m", &["a", "b", "c"]),
            ("a", &["r"]),
            ("b", &["r"]),
            ("c", &["r"]),
            ("r", &[]),
        ]);
        let merge_lines: Vec<_> = rows[0]
            .segments
            .iter()
            .filter(|s| s.half == Half::Bottom && s.from == 0)
            .map(|s| s.to)
            .collect();
        assert_eq!(merge_lines, vec![0, 1, 2]);
        assert_eq!(rows[0].width, 3);
        assert_eq!((rows[1].col, rows[2].col, rows[3].col, rows[4].col), (0, 1, 2, 0));
    }

    #[test]
    fn merging_an_already_expected_parent_reuses_its_lane() {
        // x and m are both tips; m merges x's parent p, which already has a lane.
        let rows = run(&[("x", &["p"]), ("m", &["q", "p"]), ("p", &["q"]), ("q", &[])]);
        assert_eq!(rows[1].col, 1);
        // The merge line goes into lane 0 (p's lane) instead of opening a third lane.
        assert!(
            rows[1]
                .segments
                .iter()
                .any(|s| s.half == Half::Bottom && s.from == 1 && s.to == 0)
        );
        assert!(rows.iter().all(|r| r.width <= 2));
    }

    #[test]
    fn freed_lanes_are_reused() {
        // Two short-lived side branches one after another should not widen the graph.
        let rows = run(&[
            ("m2", &["a3", "s2"]),
            ("s2", &["a2"]),
            ("a3", &["a2"]),
            ("a2", &["a1", "s1"]),
            ("s1", &["a1"]),
            ("a1", &[]),
        ]);
        assert!(rows.iter().all(|r| r.width <= 2), "{rows:?}");
        assert_eq!(rows[1].col, 1);
        assert_eq!(rows[4].col, 1);
    }

    #[test]
    fn empty_history_has_no_rows() {
        assert!(run(&[]).is_empty());
    }
}
