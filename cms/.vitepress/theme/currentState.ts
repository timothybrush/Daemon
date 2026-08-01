export interface HeroCurrentStateData {
  current_location?: string | null
  location_default?: string | null
  location_meta?: { expires?: string | null } | null
  status?: { headline?: string | null; expires?: string | null } | null
  now?: string | null
  now_meta?: { expires?: string | null } | null
}

function notExpired(item: { expires?: string | null } | null | undefined, nowMs: number): boolean {
  if (!item?.expires) return true
  const expiresAt = Date.parse(item.expires)
  return Number.isNaN(expiresAt) || expiresAt > nowMs
}

export function selectHeroCurrentState(data: HeroCurrentStateData, nowMs = Date.now()): string | null {
  if (data.current_location && data.current_location !== data.location_default && notExpired(data.location_meta, nowMs)) {
    return data.current_location
  }
  if (data.status?.headline && notExpired(data.status, nowMs)) return data.status.headline
  if (data.now && notExpired(data.now_meta, nowMs)) return data.now
  return null
}
