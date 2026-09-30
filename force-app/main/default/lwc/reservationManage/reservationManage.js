import { LightningElement, api } from 'lwc';
import cancelReservation from '@salesforce/apex/ReservationController.cancelReservation';

export default class ReservationManage extends LightningElement {
    @api confirmationNumber;
    reason;
    message;

    handleNumber(event) { this.confirmationNumber = event.target.value; }
    handleReason(event) { this.reason = event.target.value; }

    async handleCancel() {
        const result = await cancelReservation({ confirmationNumber: this.confirmationNumber, reason: this.reason });
        this.message = result.success ? `Reservation ${this.confirmationNumber} cancelled` : result.errors.map((e) => e.message).join('; ');
    }
}
