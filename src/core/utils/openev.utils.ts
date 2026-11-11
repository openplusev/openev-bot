// Selection and market wording mirrors the web app (openev src/lib/format.ts).
interface Selectable {
  market: string;
  period: string;
  side: string;
  line?: string | null;
  home: string;
  away: string;
}

function signed(line: number): string {
  return line > 0 ? `+${line}` : String(line);
}

export function sideName(sel: Selectable): string {
  const line = Number(sel.line);
  if (sel.market === "total") {
    return `${sel.side === "over" ? "Over" : "Under"} ${line}`;
  }
  if (sel.side === "draw") return "Draw";
  const team = sel.side === "home" ? sel.home : sel.away;
  if (sel.market === "asian_handicap") {
    return `${team} ${signed(sel.side === "home" ? line : -line)}`;
  }
  return team;
}

export function marketName(sel: {
  market: string;
  period: string;
  line?: string | null;
}): string {
  const period = sel.period === "first_half" ? ", 1st half" : "";
  if (sel.market === "three_way") return `Match result${period}`;
  if (sel.market === "total") return `Total ${Number(sel.line)}${period}`;
  if (sel.market === "asian_handicap") {
    return `Asian handicap ${signed(Number(sel.line))}${period}`;
  }
  return `Moneyline${period}`;
}

// League names put a spaced hyphen between country and league; embeds show a comma.
export function leagueName(league: string): string {
  return league.replace(/\s+-\s+/g, ", ");
}

export function decimalOdds(odds: string | number): string {
  return Number(odds).toFixed(2);
}

export function percent(x: number): string {
  return `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
}

// Share of bankroll; a negative edge stakes nothing.
export function kelly(odds: number, probability: number, fraction: number) {
  const b = odds - 1;
  if (b <= 0) return 0;
  return Math.max(0, ((b * probability - (1 - probability)) / b) * fraction);
}

export function unixSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}
