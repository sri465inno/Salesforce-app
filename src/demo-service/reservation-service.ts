/** Runnable Node port of force-app/main/default/classes/ReservationService.cls (in-memory, synthetic). */
import crypto from 'node:crypto';
import { CAPACITY, LOCATIONS, SEEDED_BOOKINGS } from './reference-data';
import {
  CreateReservationInput,
  PaymentInput,
  ValidationError,
  ValidatorOptions,
  validateAuthorization,
  validateAvailability,
  validateCreate,
  validateCustomerCount,
  validateDates,
  validateEmail,
  validateLocation,
  validatePaymentMethod,
  validateRequiredCustomerFields,
} from './reservation-validator';
import { maskToken } from '../shared/mask';

export interface Reservation {
  reservationId: string;
  confirmationNumber: string;
  locationId: string;
  startDate: string;
  endDate: string;
  customerCount: number;
  resourceType: string;
  status: 'PENDING' | 'CONFIRMED' | 'MODIFIED' | 'CANCELLED';
  createdAt: string;
  customer: { customerId: string; firstName: string; lastName: string; email: string };
  payment: { paymentMethod: string; paymentToken: string; authorizationStatus: string };
  cancellationReason?: string;
}

export interface ReservationPayload {
  success: boolean;
  reservation: Reservation | null;
  errors: ValidationError[];
}

export interface ModifyReservationInput {
  confirmationNumber: string;
  locationId?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  customerCount?: number | null;
  resourceType?: string | null;
}

const TOKEN_PATTERN = /^tok_synthetic_[a-z0-9]{12}$/;
const CONFIRMATION_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Mock payment gateway: synthetic tokens only, never card numbers. */
export function authorize(payment: PaymentInput | null | undefined): 'AUTHORIZED' | 'PENDING' | 'DECLINED' {
  const token = payment?.paymentToken || '';
  if (!TOKEN_PATTERN.test(token)) return 'DECLINED';
  if (token.startsWith('tok_synthetic_decline')) return 'DECLINED';
  if (token.startsWith('tok_synthetic_pending')) return 'PENDING';
  return 'AUTHORIZED';
}

export class ReservationService {
  private reservations: Reservation[] = [];
  private sequence = 0;

  constructor(private readonly options: ValidatorOptions = {}) {}

  locations() {
    return LOCATIONS;
  }

  availability(locationId: string, resourceType: string, startDate: string, endDate: string, excludeConfirmation?: string) {
    const overlaps = (b: { startDate: string; endDate: string }) => b.startDate < endDate && startDate < b.endDate;
    const booked = [
      ...SEEDED_BOOKINGS.filter((b) => b.locationId === locationId && b.resourceType === resourceType && overlaps(b)),
      ...this.reservations.filter(
        (r) => r.status !== 'CANCELLED' && r.confirmationNumber !== excludeConfirmation && r.locationId === locationId && r.resourceType === resourceType && overlaps(r),
      ),
    ].length;
    const remaining = Math.max(0, (CAPACITY[resourceType] ?? 0) - booked);
    return { available: remaining > 0, remaining };
  }

  createReservation(input: CreateReservationInput): ReservationPayload {
    const errors = validateCreate(input, this.options);
    let authorizationStatus = 'DECLINED';
    if (!errors.length) {
      authorizationStatus = authorize(input.payment);
      const authError = validateAuthorization(authorizationStatus);
      if (authError) errors.push(authError);
    }
    if (!errors.length) {
      const availability = this.availability(input.locationId!, input.resourceType || '', input.startDate!, input.endDate!);
      const availabilityError = validateAvailability(availability.available);
      if (availabilityError) errors.push(availabilityError);
    }
    if (errors.length) return { success: false, reservation: null, errors };

    this.sequence += 1;
    const reservation: Reservation = {
      reservationId: `RSV-SYN-${String(this.sequence).padStart(6, '0')}`,
      confirmationNumber: this.confirmationNumber(), // @rule BR-005 CONFIRMATION_NUMBER
      locationId: input.locationId!,
      startDate: input.startDate!,
      endDate: input.endDate!,
      customerCount: input.customerCount!,
      resourceType: input.resourceType || 'STANDARD_ROOM',
      status: 'CONFIRMED',
      createdAt: new Date().toISOString(),
      customer: {
        customerId: `CUS-SYN-${String(this.sequence).padStart(6, '0')}`,
        firstName: input.customer!.firstName!,
        lastName: input.customer!.lastName!,
        email: input.customer!.email!,
      },
      payment: { paymentMethod: input.payment!.paymentMethod!, paymentToken: maskToken(input.payment!.paymentToken!), authorizationStatus },
    };
    this.reservations.push(reservation);
    return { success: true, reservation, errors: [] };
  }

  find(confirmationNumber: string): Reservation | null {
    return this.reservations.find((r) => r.confirmationNumber === confirmationNumber) ?? null;
  }

  search(filter: { confirmationNumber?: string | null; lastName?: string | null; locationId?: string | null; status?: string | null }): Reservation[] {
    return this.reservations
      .filter((r) => !filter.confirmationNumber || r.confirmationNumber === filter.confirmationNumber)
      .filter((r) => !filter.lastName || r.customer.lastName.toLowerCase() === filter.lastName.toLowerCase())
      .filter((r) => !filter.locationId || r.locationId === filter.locationId)
      .filter((r) => !filter.status || r.status === filter.status)
      .slice(-50)
      .reverse();
  }

  modifyReservation(input: ModifyReservationInput): ReservationPayload {
    const existing = this.find(input.confirmationNumber);
    if (!existing) return { success: false, reservation: null, errors: [notFound()] };
    if (existing.status === 'CANCELLED') return { success: false, reservation: null, errors: [transition('Cancelled reservations cannot be modified')] };
    const merged = {
      locationId: input.locationId ?? existing.locationId,
      startDate: input.startDate ?? existing.startDate,
      endDate: input.endDate ?? existing.endDate,
      customerCount: input.customerCount ?? existing.customerCount,
      resourceType: input.resourceType ?? existing.resourceType,
    };
    const errors: ValidationError[] = [];
    validateDates(merged, errors);
    validateCustomerCount(merged, errors, this.options);
    validateLocation(merged, errors);
    if (!errors.length) {
      const availabilityError = validateAvailability(this.availability(merged.locationId, merged.resourceType, merged.startDate, merged.endDate, existing.confirmationNumber).available);
      if (availabilityError) errors.push(availabilityError);
    }
    if (errors.length) return { success: false, reservation: null, errors };
    Object.assign(existing, merged, { status: 'MODIFIED' });
    return { success: true, reservation: existing, errors: [] };
  }

  cancelReservation(confirmationNumber: string, reason?: string | null): ReservationPayload {
    const existing = this.find(confirmationNumber);
    if (!existing) return { success: false, reservation: null, errors: [notFound()] };
    if (existing.status === 'CANCELLED') return { success: false, reservation: null, errors: [transition('Reservation is already cancelled')] };
    existing.status = 'CANCELLED';
    existing.cancellationReason = reason || undefined;
    return { success: true, reservation: existing, errors: [] };
  }

  validateCustomer(customer: CreateReservationInput['customer']) {
    const errors: ValidationError[] = [];
    validateRequiredCustomerFields({ customer }, errors);
    validateEmail({ customer }, errors);
    return { valid: !errors.length, errors, authorizationStatus: null };
  }

  validatePayment(payment: PaymentInput) {
    const errors: ValidationError[] = [];
    validatePaymentMethod({ payment }, errors);
    const authorizationStatus = authorize(payment);
    const authError = validateAuthorization(authorizationStatus);
    if (authError) errors.push(authError);
    return { valid: !errors.length, errors, authorizationStatus };
  }

  private confirmationNumber(): string {
    let value = 'CNF-';
    while (value.length < 12) value += CONFIRMATION_CHARS[crypto.randomInt(CONFIRMATION_CHARS.length)];
    return value;
  }
}

function notFound(): ValidationError {
  return { code: 'RESERVATION_NOT_FOUND', field: 'confirmationNumber', message: 'Reservation not found', ruleId: null };
}

function transition(message: string): ValidationError {
  return { code: 'INVALID_STATUS_TRANSITION', field: 'status', message, ruleId: null };
}
