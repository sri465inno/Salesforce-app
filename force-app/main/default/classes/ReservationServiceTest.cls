/** Apex unit tests (reference only: the MVP runs without a Salesforce org; the executable suite is generated Playwright). */
@IsTest
private class ReservationServiceTest {
    private static ReservationService.CreateReservationInput validInput() {
        ReservationService.CreateReservationInput input = new ReservationService.CreateReservationInput();
        input.locationId = 'LOC-SYN-001';
        input.startDate = Date.newInstance(2027, 1, 10);
        input.endDate = Date.newInstance(2027, 1, 12);
        input.customerCount = 2;
        input.resourceType = 'STANDARD_ROOM';
        input.customer = new ReservationService.CustomerInput();
        input.customer.firstName = 'Avery';
        input.customer.lastName = 'Synthwell';
        input.customer.email = 'avery.synthwell@example.test';
        input.payment = new ReservationService.PaymentInput();
        input.payment.paymentMethod = 'CARD_TOKEN';
        input.payment.paymentToken = 'tok_synthetic_a1b2c3d4e5f6';
        return input;
    }

    @IsTest
    static void rejectsEndBeforeStart() {
        ReservationService.CreateReservationInput input = validInput();
        input.endDate = Date.newInstance(2027, 1, 9);
        System.assertEquals('INVALID_DATE_RANGE', ReservationValidator.validateCreate(input)[0].code);
    }
}
