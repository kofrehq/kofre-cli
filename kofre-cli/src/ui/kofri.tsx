import { useEffect, useState } from "react";
import { Box, Text } from "ink";

/** Mismos colores que Kofri en la web (kofre-web/components/kofri.tsx). */
export const COLORS = { lid: "#C9A227", body: "#E0B83D", eye: "#E8EAED", key: "#9AA3B2", cheek: "#E85D4C", dim: "#5A6478" };

export type KofriMood = "idle" | "loading" | "happy" | "sad";

export const reducedMotion = () => Boolean(process.env.KOFRE_REDUCED_MOTION || process.env.NO_COLOR);

/** Un contador que avanza cada `ms` mientras el componente está montado (salvo con KOFRE_REDUCED_MOTION). */
export function useTick(ms = 150): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (reducedMotion()) return;
    const id = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return tick;
}

type Seg = [text: string, color?: string];

function eyes(mood: KofriMood, tick: number): Seg[] {
  const blink = mood === "idle" && tick % 27 === 0 && tick > 0;
  const glyph = blink ? "─" : mood === "happy" ? "^" : mood === "sad" ? "╥" : mood === "loading" ? "°" : "●";
  return [["  "], [glyph, COLORS.eye], ["   "], [glyph, COLORS.eye], ["  "]];
}

function mouth(mood: KofriMood): Seg[] {
  if (mood === "happy") return [[" "], ["◦", COLORS.cheek], ["  "], ["‿", COLORS.body], ["  "], ["◦", COLORS.cheek], [" "]];
  if (mood === "sad") return [["    "], ["∩", COLORS.key], ["    "]];
  return [["    "], ["▾", COLORS.key], ["    "]];
}

/**
 * Kofri en la terminal: flota, parpadea y asoma la tapa en reposo; mira arriba mientras carga; se alegra con
 * destellos cuando algo sale bien y se entristece si falla. Siempre ocupa 7 filas para no mover el resto.
 */
export function Kofri({ mood }: { mood: KofriMood }) {
  const tick = useTick(150);
  const peek = mood === "happy" || (mood === "idle" && tick % 40 >= 30 && tick % 40 < 34);
  const bob = mood === "loading" ? tick % 6 < 3 : Math.floor(tick / 4) % 2 === 1;
  const spark = mood === "happy" ? (tick % 4 < 2 ? "✦" : "✧") : " ";
  const dots = mood === "loading" ? "·".repeat((tick % 4) + 0).padEnd(3) : "   ";

  const row = (segs: Seg[], key: string) => (
    <Text key={key}>
      {segs.map(([text, color], i) => (
        <Text key={i} color={color}>
          {text}
        </Text>
      ))}
    </Text>
  );
  const edge = (text: string): Seg => [text, COLORS.lid];
  const rows: Seg[][] = peek
    ? [
        [[spark, COLORS.body], edge("╭─────────╮"), [spark, COLORS.body]],
        [[" "], edge("╰────◆────╯"), [" "]],
        [[" "], edge("┌"), ["✦·  ✦  ·✦", COLORS.body], edge("┐"), [" "]],
      ]
    : [
        [["             "]],
        [[" "], edge("╭─────────╮"), [" "]],
        [[" "], edge("├────"), ["◆", COLORS.body], edge("────┤"), [" "]],
      ];
  rows.push([[" "], edge("│"), ...eyes(mood, tick), edge("│"), [dots, COLORS.dim]]);
  rows.push([[" "], edge("│"), ...mouth(mood), edge("│"), [" "]]);
  rows.push([[" "], edge("╰─────────╯"), [" "]]);

  return (
    <Box flexDirection="column" height={7} width={16} paddingTop={bob ? 1 : 0}>
      {rows.map((segs, i) => row(segs, String(i)))}
    </Box>
  );
}

/** Kofri en una línea para ventanas bajas: el mismo gesto (ojos y boca) sin el cuerpo. */
export function KofriMini({ mood }: { mood: KofriMood }) {
  const tick = useTick(150);
  const eye = eyes(mood, tick).filter(([, color]) => color)[0][0];
  const face = mood === "happy" ? "‿" : mood === "sad" ? "∩" : "▾";
  const spark = mood === "happy" && tick % 4 < 2 ? "✦" : mood === "loading" ? "·".repeat(tick % 4).padEnd(3) : "";
  return (
    <Text>
      <Text color={COLORS.lid}>[</Text>
      <Text color={COLORS.eye}>{eye}</Text>
      <Text color={mood === "happy" ? COLORS.body : COLORS.key}>{face}</Text>
      <Text color={COLORS.eye}>{eye}</Text>
      <Text color={COLORS.lid}>]</Text>
      <Text color={COLORS.body}>{spark}</Text>
    </Text>
  );
}

/** Texto que aparece letra a letra; con KOFRE_REDUCED_MOTION aparece entero. */
export function Typewriter({ text, color, ms = 25 }: { text: string; color?: string; ms?: number }) {
  const [shown, setShown] = useState(reducedMotion() ? text.length : 0);
  useEffect(() => {
    if (reducedMotion()) return setShown(text.length);
    setShown(0);
    const id = setInterval(() => setShown((n) => (n >= text.length ? n : n + 1)), ms);
    return () => clearInterval(id);
  }, [text, ms]);
  return <Text color={color}>{text.slice(0, shown)}</Text>;
}
