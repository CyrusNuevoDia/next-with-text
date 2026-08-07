import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Zebra",
  description: "Alphabetically after llms-full.txt — ordering probe.",
}

export default async function Zebra() {
  await new Promise((r) => setTimeout(r, 3000)) // keep the prerender phase open

  return (
    <article>
      <h1>Zebra</h1>
      <p>SENTINEL_ZEBRA: sorts after the llms routes.</p>
    </article>
  )
}
