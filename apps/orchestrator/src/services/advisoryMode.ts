/**
 * Whether a user receives advice (D388): the one place every real-portfolio
 * view asks.
 *
 * D386 made advice everyone's behaviour and D265 (public signup closed until
 * the legal text exists) the only gate, so this answers true for every user.
 * M13 (D388) will make it per user - observation by default, advice only for a
 * user who accepted the advisory terms - and changes this function, not its
 * callers. Each D387 surface reads it before it writes a view on the real
 * portfolio: the research proposals (D389), then Ask's drafted proposals and
 * the alert narration's view.
 */
export async function isAdvisory(_userId: string): Promise<boolean> {
  return true;
}
