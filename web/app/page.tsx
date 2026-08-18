import { renderShape, DENOMINATIONS, LABELS, GRIDS } from "@shared/canonical/render";
import { geneAtMint } from "@shared/canonical/ink";
import styles from "./page.module.css";

// Deterministic sample seeds for the marketing ladder, so the home page renders the same nine
// Shapes on every build. Not chain seeds — those are assigned at mint. splitmix64 over a lane.
function sampleSeed(n: number): bigint {
  const MASK = (1n << 256n) - 1n;
  let x = (BigInt(n) * 0x9e3779b97f4a7c15n + 0x243f6a8885a308d3n) & MASK;
  x ^= x >> 29n;
  x = (x * 0xbf58476d1ce4e5b9n) & MASK;
  x ^= x >> 32n;
  x = (x * 0x94d049bb133111ebn) & MASK;
  x ^= x >> 31n;
  return x & MASK;
}

export default function Home() {
  const ladder = DENOMINATIONS.map((wei, i) => {
    const seed = sampleSeed(7000 + i * 13);
    const svg = renderShape(seed, wei, 0n, geneAtMint(seed, i));
    const [cols, rows] = GRIDS[i];
    return { label: LABELS[i], marks: cols * rows, grid: `${cols}x${rows}`, svg };
  });

  return (
    <main className={styles.main}>
      <header className={styles.hero}>
        <h1 className={styles.title}>
          ETH in, Shape out.
          <br />
          Shape burned, ETH returned.
        </h1>
        <p className={styles.lede}>
          A Shape is an ERC721 that wraps an exact amount of ETH. Burn it and you receive exactly
          that ETH back — not a share of a pool, not a proportion. The same wei. Nine denominations,
          0.01 to 100 ETH. The artwork is generated and stored entirely on chain.
        </p>
      </header>

      <section className={styles.ladder} aria-label="The nine denominations">
        {ladder.map((s) => (
          <figure key={s.label} className={styles.card}>
            <div className={styles.art} dangerouslySetInnerHTML={{ __html: s.svg }} />
            <figcaption className={styles.caption}>
              <span className={styles.eth}>{s.label} ETH</span>
              <span className={styles.marks}>
                {s.grid} · {s.marks} {s.marks === 1 ? "mark" : "marks"}
              </span>
            </figcaption>
          </figure>
        ))}
      </section>

      <footer className={styles.foot}>
        Fully on-chain. Exactly redeemable. No admin power over the reserve.
      </footer>
    </main>
  );
}
