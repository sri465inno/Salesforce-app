/** Synthetic reference data for the demo service (mirrors fixtures/inputs/data-dictionary.json). */
export interface Location {
  locationId: string;
  name: string;
  active: boolean;
}

export const LOCATIONS: Location[] = [
  { locationId: 'LOC-SYN-001', name: 'Synthetic Downtown Centre', active: true },
  { locationId: 'LOC-SYN-002', name: 'Synthetic Airport Lodge', active: true },
  { locationId: 'LOC-SYN-003', name: 'Synthetic Harbour Suites', active: true },
  { locationId: 'LOC-SYN-004', name: 'Synthetic Closed Annex', active: false },
];

export const RESOURCE_TYPES = ['STANDARD_ROOM', 'SUITE', 'CONFERENCE_ROOM'] as const;
export const PAYMENT_METHODS = ['CARD_TOKEN', 'INVOICE', 'CASH', 'GIFT_VOUCHER'] as const;
export const APPROVED_PAYMENT_METHODS = ['CARD_TOKEN', 'INVOICE'];

/** Units of each resource type per location. */
export const CAPACITY: Record<string, number> = { STANDARD_ROOM: 20, SUITE: 1, CONFERENCE_ROOM: 2 };

/** Pre-existing bookings that make some resources unavailable (BR-007). */
export const SEEDED_BOOKINGS = [
  { locationId: 'LOC-SYN-002', resourceType: 'SUITE', startDate: '2027-03-10', endDate: '2027-03-15' },
];
