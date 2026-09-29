/**
 * Apex service layer for reservation management (create, search, modify, cancel).
 * Exposed to Lightning Web Components through ReservationController and to integrations
 * through the GraphQL contract in contracts/reservation.graphql.
 */
public with sharing class ReservationService {

    public class CustomerInput { public String firstName; public String lastName; public String email; }
    public class PaymentInput { public String paymentMethod; public String paymentToken; }
    public class CreateReservationInput {
        public String locationId; public Date startDate; public Date endDate; public Integer customerCount;
        public String resourceType; public CustomerInput customer; public PaymentInput payment;
    }
    public class ReservationPayload {
        @AuraEnabled public Boolean success;
        @AuraEnabled public Reservation__c reservation;
        @AuraEnabled public List<ReservationValidator.ValidationError> errors;
    }

    public static ReservationPayload createReservation(CreateReservationInput input) {
        ReservationPayload payload = new ReservationPayload();
        payload.errors = ReservationValidator.validateCreate(input);
        if (payload.errors.isEmpty()) {
            String authorization = PaymentGateway.authorize(input.payment.paymentToken);
            ReservationValidator.ValidationError authError = ReservationValidator.validateAuthorization(authorization);
            if (authError != null) payload.errors.add(authError);
        }
        if (payload.errors.isEmpty()) {
            ReservationValidator.ValidationError availability = ReservationValidator.validateAvailability(input);
            if (availability != null) payload.errors.add(availability);
        }
        if (!payload.errors.isEmpty()) {
            payload.success = false;
            return payload;
        }
        Reservation__c record = new Reservation__c(
            Location__c = input.locationId,
            Start_Date__c = input.startDate,
            End_Date__c = input.endDate,
            Customer_Count__c = input.customerCount,
            Resource_Type__c = input.resourceType,
            Status__c = 'CONFIRMED',
            Confirmation_Number__c = generateConfirmationNumber() // @rule BR-005 CONFIRMATION_NUMBER
        );
        insert record;
        payload.success = true;
        payload.reservation = record;
        return payload;
    }

    public static List<Reservation__c> searchReservations(String confirmationNumber, String lastName, String locationId, String status) {
        String query = 'SELECT Id, Confirmation_Number__c, Location__c, Start_Date__c, End_Date__c, Customer_Count__c, Resource_Type__c, Status__c FROM Reservation__c WHERE Id != null';
        if (String.isNotBlank(confirmationNumber)) query += ' AND Confirmation_Number__c = :confirmationNumber';
        if (String.isNotBlank(lastName)) query += ' AND Customer__r.LastName = :lastName';
        if (String.isNotBlank(locationId)) query += ' AND Location__c = :locationId';
        if (String.isNotBlank(status)) query += ' AND Status__c = :status';
        return Database.query(query + ' ORDER BY CreatedDate DESC LIMIT 50');
    }

    public static ReservationPayload cancelReservation(String confirmationNumber, String reason) {
        ReservationPayload payload = new ReservationPayload();
        payload.errors = new List<ReservationValidator.ValidationError>();
        List<Reservation__c> found = searchReservations(confirmationNumber, null, null, null);
        if (found.isEmpty()) {
            payload.errors.add(new ReservationValidator.ValidationError('RESERVATION_NOT_FOUND', 'confirmationNumber', 'Reservation not found', null));
        } else if (found[0].Status__c == 'CANCELLED') {
            payload.errors.add(new ReservationValidator.ValidationError('INVALID_STATUS_TRANSITION', 'status', 'Reservation is already cancelled', null));
        } else {
            found[0].Status__c = 'CANCELLED';
            found[0].Cancellation_Reason__c = reason;
            update found[0];
            payload.reservation = found[0];
        }
        payload.success = payload.errors.isEmpty();
        return payload;
    }

    private static String generateConfirmationNumber() {
        String chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        String value = 'CNF-';
        while (value.length() < 12) {
            Integer idx = Math.mod(Math.abs(Crypto.getRandomInteger()), chars.length());
            value += chars.substring(idx, idx + 1);
        }
        return value;
    }
}
