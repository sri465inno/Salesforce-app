/** @AuraEnabled entry points used by the createReservation, reservationSearch and reservationManage LWCs. */
public with sharing class ReservationController {
    @AuraEnabled
    public static ReservationService.ReservationPayload createReservation(String inputJson) {
        return ReservationService.createReservation((ReservationService.CreateReservationInput) JSON.deserialize(inputJson, ReservationService.CreateReservationInput.class));
    }

    @AuraEnabled(cacheable=true)
    public static List<Reservation__c> searchReservations(String confirmationNumber, String lastName) {
        return ReservationService.searchReservations(confirmationNumber, lastName, null, null);
    }

    @AuraEnabled
    public static ReservationService.ReservationPayload cancelReservation(String confirmationNumber, String reason) {
        return ReservationService.cancelReservation(confirmationNumber, reason);
    }
}
