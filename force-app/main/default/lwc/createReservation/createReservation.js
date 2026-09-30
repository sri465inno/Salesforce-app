import { LightningElement, track } from 'lwc';
import createReservation from '@salesforce/apex/ReservationController.createReservation';

export default class CreateReservation extends LightningElement {
    @track input = { customer: {}, payment: {} };
    confirmationNumber;
    errors = [];

    locationOptions = [
        { label: 'Synthetic Downtown Centre', value: 'LOC-SYN-001' },
        { label: 'Synthetic Airport Lodge', value: 'LOC-SYN-002' },
        { label: 'Synthetic Harbour Suites', value: 'LOC-SYN-003' }
    ];
    resourceOptions = ['STANDARD_ROOM', 'SUITE', 'CONFERENCE_ROOM'].map((v) => ({ label: v, value: v }));
    paymentOptions = ['CARD_TOKEN', 'INVOICE', 'CASH', 'GIFT_VOUCHER'].map((v) => ({ label: v, value: v }));

    handleChange(event) {
        const path = event.target.dataset.field.split('.');
        const value = path[0] === 'customerCount' ? Number(event.target.value) : event.target.value;
        if (path.length === 2) this.input[path[0]][path[1]] = value;
        else this.input[path[0]] = value;
    }

    async handleSubmit() {
        const result = await createReservation({ inputJson: JSON.stringify(this.input) });
        this.errors = result.errors;
        this.confirmationNumber = result.success ? result.reservation.Confirmation_Number__c : undefined;
    }
}
