import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Stat tile: one quiet padded surface — an icon + label row, the metric as
 * the loudest thing on the tile, then an optional context line under it.
 * Every tile keeps the same three-line shape (empty hint included) so a row
 * of them stays even, and the value truncates rather than wraps so a long
 * composite (rule codes, durations) cannot break the grid. An optional href
 * turns the whole tile into a quiet link; the wrapper stretches full-height
 * so linked tiles match their row. */
export function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  href,
  valueClassName,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  href?: string;
  /** State tint for the value (e.g. text-error-foreground); colors carry
   * state, so only pass one when the metric is in that state. */
  valueClassName?: string;
}) {
  const card = (
    <Card className="h-full">
      <CardContent className="flex h-full flex-col justify-center">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Icon className="size-4 shrink-0" aria-hidden />
          {label}
        </div>
        <div
          className={cn(
            "mt-1 truncate text-[28px] font-semibold leading-tight tabular-nums",
            valueClassName,
          )}
        >
          {value}
        </div>
        <div className="mt-1 truncate text-xs text-muted-foreground">{hint ?? "\u00a0"}</div>
      </CardContent>
    </Card>
  );
  if (!href) return card;
  return (
    <a
      href={href}
      className="block h-full rounded-lg outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring/60 hover:shadow-sm"
      aria-label={`${label}: ${value}`}
    >
      {card}
    </a>
  );
}
