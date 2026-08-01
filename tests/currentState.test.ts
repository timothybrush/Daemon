import { expect, test } from 'bun:test'
import { selectHeroCurrentState } from '../cms/.vitepress/theme/currentState'

const NOW = Date.parse('2026-08-01T12:00:00.000Z')

test('active non-default location wins over status and now', () => {
  expect(selectHeroCurrentState({
    current_location: 'Lisbon — Conference',
    location_default: 'Home Region',
    location_meta: { expires: '2026-08-10T12:00:00.000Z' },
    status: { headline: 'Building LifeOS', expires: '2026-08-04T00:00:00.000Z' },
    now: 'Shipping weekly',
    now_meta: { expires: '2026-08-04T00:00:00.000Z' },
  }, NOW)).toBe('Lisbon — Conference')
})

test("default location falls back to unexpired status headline", () => {
  expect(selectHeroCurrentState({
    current_location: "Home Region",
    location_default: "Home Region",
    status: { headline: "Building LifeOS", expires: "2026-08-04T00:00:00.000Z" },
    now: "Shipping weekly",
    now_meta: { expires: "2026-08-04T00:00:00.000Z" },
  }, NOW)).toBe("Building LifeOS")
})

test("expired non-default location falls back to unexpired status headline", () => {
  expect(selectHeroCurrentState({
    current_location: "Lisbon",
    location_default: "Home Region",
    location_meta: { expires: "2026-08-01T11:59:59.000Z" },
    status: { headline: "Building LifeOS", expires: "2026-08-04T00:00:00.000Z" },
  }, NOW)).toBe("Building LifeOS")
})

test("expired status falls back to unexpired now", () => {
  expect(selectHeroCurrentState({
    current_location: "Home Region",
    location_default: "Home Region",
    status: { headline: "Stale status", expires: "2026-08-01T11:59:59.000Z" },
    now: "Shipping weekly",
    now_meta: { expires: "2026-08-04T00:00:00.000Z" },
  }, NOW)).toBe("Shipping weekly")
})
