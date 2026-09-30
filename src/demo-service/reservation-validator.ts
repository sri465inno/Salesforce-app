/**
 * Runnable Node port of force-app/main/default/classes/ReservationValidator.cls.
 * `@rule` markers are indexed by scripts/record-source-refs.ts into
 * fixtures/inputs/source-code-references.json.
 */
import { APPROVED_PAYMENT_METHODS, LOCATIONS } from './reference-data';

export interface ValidationError {
  code: string;
  field: string | null;
  message: string;
  ruleId: string | null;
}

export interface CustomerInput {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}

export interface PaymentInput {
  paymentMethod?: string | null;
  paymentToken?: string | null;
}

export interface CreateReservationInput {
  locationId?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  customerCount?: number | null;
  resourceType?: string | null;
  customer?: CustomerInput | null;
  payment?: PaymentInput | null;
}

export interface ValidatorOptions {
  /** Rule IDs whose seeded defect is switched off (used to demonstrate a passing re-run). */
  fixedDefects?: string[];
}

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const blank = (v: string | null | undefined) => v === undefined || v === null || String(v).trim() === '';

export function validateCreate(input: CreateReservationInput, options: ValidatorOptions = {}): ValidationError[] {
  const errors: ValidationError[] = [];
  validateRequiredCustomerFields(input, errors);
  validateEmail(input, errors);
  validateDates(input, errors);
  validateCustomerCount(input, errors, options);
  validateLocation(input, errors);
  validatePaymentMethod(input, errors);
  return errors;
}

// @rule BR-006 MISSING_REQUIRED_FIELD
export function validateRequiredCustomerFields(input: CreateReservationInput, errors: ValidationError[]): void {
  for (const field of ['firstName', 'lastName', 'email'] as const) {
    if (blank(input.customer?.[field])) {
      errors.push({ code: 'MISSING_REQUIRED_FIELD', field: `customer.${field}`, message: `customer.${field} is required`, ruleId: 'BR-006' });
    }
  }
}

// @rule BR-D01 INVALID_EMAIL
export function validateEmail(input: CreateReservationInput, errors: ValidationError[]): void {
  const email = input.customer?.email;
  if (!blank(email) && !EMAIL_PATTERN.test(String(email))) {
    errors.push({ code: 'INVALID_EMAIL', field: 'customer.email', message: 'Email address is not valid', ruleId: 'BR-D01' });
  }
}

// @rule BR-001 INVALID_DATE_RANGE
export function validateDates(input: CreateReservationInput, errors: ValidationError[]): void {
  const { startDate, endDate } = input;
  if (!startDate || !endDate || !ISO_DATE.test(startDate) || !ISO_DATE.test(endDate) || startDate >= endDate) {
    errors.push({ code: 'INVALID_DATE_RANGE', field: 'startDate', message: 'Start date must be earlier than end date', ruleId: 'BR-001' });
  }
}

// @rule BR-002 INVALID_CUSTOMER_COUNT
export function validateCustomerCount(input: CreateReservationInput, errors: ValidationError[], options: ValidatorOptions = {}): void {
  const count = input.customerCount;
  const lowerBound = options.fixedDefects?.includes('BR-002') ? 1 : 0;
  if (count === undefined || count === null || !Number.isInteger(count) || count < lowerBound || count > 10) {
    errors.push({ code: 'INVALID_CUSTOMER_COUNT', field: 'customerCount', message: 'Customer count must be between 1 and 10', ruleId: 'BR-002' });
  }
}

// @rule BR-003 INVALID_LOCATION
export function validateLocation(input: CreateReservationInput, errors: ValidationError[]): void {
  const location = LOCATIONS.find((l) => l.locationId === input.locationId);
  if (!location || !location.active) {
    errors.push({ code: 'INVALID_LOCATION', field: 'locationId', message: 'A valid, active location is required', ruleId: 'BR-003' });
  }
}

// @rule BR-004 PAYMENT_METHOD_NOT_APPROVED
export function validatePaymentMethod(input: CreateReservationInput, errors: ValidationError[]): void {
  const method = input.payment?.paymentMethod;
  if (!method || !APPROVED_PAYMENT_METHODS.includes(method)) {
    errors.push({ code: 'PAYMENT_METHOD_NOT_APPROVED', field: 'payment.paymentMethod', message: 'An approved payment method is required', ruleId: 'BR-004' });
  }
}

// @rule BR-D02 PAYMENT_NOT_AUTHORIZED
export function validateAuthorization(authorizationStatus: string): ValidationError | null {
  return authorizationStatus === 'AUTHORIZED'
    ? null
    : { code: 'PAYMENT_NOT_AUTHORIZED', field: 'payment.paymentToken', message: 'Payment was not authorized', ruleId: 'BR-D02' };
}

// @rule BR-007 RESOURCE_UNAVAILABLE
export function validateAvailability(available: boolean): ValidationError | null {
  return available
    ? null
    : { code: 'RESOURCE_UNAVAILABLE', field: 'resourceType', message: 'The requested resource is not available for the selected dates', ruleId: 'BR-007' };
}
