import { memo } from "react";
import { GraphRow } from "../api";
import { laneColor } from "../util";

export const LANE_WIDTH = 14;
export const ROW_HEIGHT = 26;
export const MAX_GRAPH_LANES = 14;

const x = (lane: number) => LANE_WIDTH / 2 + lane * LANE_WIDTH + 4;

interface GraphCellProps {
  row: GraphRow;
  isMerge: boolean;
  isHead: boolean;
  width: number;
}

/** Draws one row of the commit graph: the lane segments plus the commit dot. */
export const GraphCell = memo(function GraphCell({ row, isMerge, isHead, width }: GraphCellProps) {
  const mid = ROW_HEIGHT / 2;
  return (
    <svg className="graph-cell" width={width} height={ROW_HEIGHT}>
      {row.segments.map((s, i) => {
        const [y1, y2] = s.half === "top" ? [0, mid] : [mid, ROW_HEIGHT];
        const x1 = x(s.from);
        const x2 = x(s.to);
        const ym = (y1 + y2) / 2;
        const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`;
        return <path key={i} d={d} stroke={laneColor(s.color)} strokeWidth={2} fill="none" />;
      })}
      {isHead && <circle cx={x(row.col)} cy={mid} r={7} fill="none" stroke={laneColor(row.color)} strokeWidth={1.5} />}
      <circle
        cx={x(row.col)}
        cy={mid}
        r={isMerge ? 3.5 : 4.5}
        fill={laneColor(row.color)}
        stroke="var(--bg)"
        strokeWidth={1.5}
      />
    </svg>
  );
});

export function graphWidth(lanes: number): number {
  return Math.min(Math.max(lanes, 1), MAX_GRAPH_LANES) * LANE_WIDTH + 8;
}
