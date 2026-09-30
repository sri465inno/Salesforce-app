/**
 * Business-rule validation for reservations (STORY-001).
 * The runnable Node port is src/demo-service/reservation-validator.ts; both carry the same
 * `@rule` markers, from which fixtures/inputs/source-code-references.json is generated.
 */
public with sharing class ReservationValidator {

    public class ValidationError {
        @AuraEnabled public String code;
        @AuraEnabled public String field;
        @AuraEnabled public String message;
        @AuraEnabled public String ruleId;
        public ValidationError(String code, String field, String message, String ruleId) {
            this.code = code; this.field = field; this.message = message; this.ruleId = ruleId;
        }
    }

    private static final Set<String> APPROVED_PAYMENT_METHODS = new Set<String>{ 'CARD_TOKEN', 'INVOICE' };
    private static final Pattern EMAIL_PATTERN = Pattern.compile('^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$');

    public static List<ValidationError> validateCreate(ReservationService.CreateReservationInput input) {
        List<ValidationError> errors = new List<ValidationError>();
        validateRequiredCustomerFields(input, errors);
        validateEmail(input, errors);
        validateDates(input, errors);
        validateCustomerCount(input, errors);
        validateLocation(input, errors);
        validatePaymentMethod(input, errors);
        return errors;
    }

    // @rule BR-006 MISSING_REQUIRED_FIELD
    private static void validateRequiredCustomerFields(ReservationService.CreateReservationInput input, List<ValidationError> errors) {
        Map<String, String> required = new Map<String, String>{
            'customer.firstName' => input.customer == null ? null : input.customer.firstName,
            'customer.lastName' => input.customer == null ? null : input.customer.lastName,
            'customer.email' => input.customer == null ? null : input.customer.email
        };
        for (String field : required.keySet()) {
            if (String.isBlank(required.get(field))) {
                errors.add(new ValidationError('MISSING_REQUIRED_FIELD', field, field + ' is required', 'BR-006'));
            }
        }
    }

    // @rule BR-D01 INVALID_EMAIL
    private static void validateEmail(ReservationService.CreateReservationInput input, List<ValidationError> errors) {
        if (input.customer != null && String.isNotBlank(input.customer.email) && !EMAIL_PATTERN.matcher(input.customer.email).matches()) {
            errors.add(new ValidationError('INVALID_EMAIL', 'customer.email', 'Email address is not valid', 'BR-D01'));
        }
    }

    // @rule BR-001 INVALID_DATE_RANGE
    private static void validateDates(ReservationService.CreateReservationInput input, List<ValidationError> errors) {
        if (input.startDate == null || input.endDate == null || input.startDate >= input.endDate) {
            errors.add(new ValidationError('INVALID_DATE_RANGE', 'startDate', 'Start date must be earlier than end date', 'BR-001'));
        }
    }

    // @rule BR-002 INVALID_CUSTOMER_COUNT
    private static void validateCustomerCount(ReservationService.CreateReservationInput input, List<ValidationError> errors) {
        if (input.customerCount == null || input.customerCount < 0 || input.customerCount > 10) {
            errors.add(new ValidationError('INVALID_CUSTOMER_COUNT', 'customerCount', 'Customer count must be between 1 and 10', 'BR-002'));
        }
    }

    // @rule BR-003 INVALID_LOCATION
    private static void validateLocation(ReservationService.CreateReservationInput input, List<ValidationError> errors) {
        if (String.isBlank(input.locationId) || !LocationDirectory.isActive(input.locationId)) {
            errors.add(new ValidationError('INVALID_LOCATION', 'locationId', 'A valid, active location is required', 'BR-003'));
        }
    }

    // @rule BR-004 PAYMENT_METHOD_NOT_APPROVED
    private static void validatePaymentMethod(ReservationService.CreateReservationInput input, List<ValidationError> errors) {
        if (input.payment == null || input.payment.paymentMethod == null || !APPROVED_PAYMENT_METHODS.contains(input.payment.paymentMethod)) {
            errors.add(new ValidationError('PAYMENT_METHOD_NOT_APPROVED', 'payment.paymentMethod', 'An approved payment method is required', 'BR-004'));
        }
    }

    // @rule BR-D02 PAYMENT_NOT_AUTHORIZED
    public static ValidationError validateAuthorization(String authorizationStatus) {
        if (authorizationStatus != 'AUTHORIZED') {
            return new ValidationError('PAYMENT_NOT_AUTHORIZED', 'payment.paymentToken', 'Payment was not authorized', 'BR-D02');
        }
        return null;
    }

    // @rule BR-007 RESOURCE_UNAVAILABLE
    public static ValidationError validateAvailability(ReservationService.CreateReservationInput input) {
        if (!InventoryService.isAvailable(input.locationId, input.resourceType, input.startDate, input.endDate)) {
            return new ValidationError('RESOURCE_UNAVAILABLE', 'resourceType', 'The requested resource is not available for the selected dates', 'BR-007');
        }
        return null;
    }
}
