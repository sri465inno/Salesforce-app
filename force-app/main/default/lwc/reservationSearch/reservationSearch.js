import { LightningElement } from 'lwc';
import searchReservations from '@salesforce/apex/ReservationController.searchReservations';

export default class ReservationSearch extends LightningElement {
    filter = {};
    results = [];
    columns = [
        { label: 'Confirmation', fieldName: 'Confirmation_Number__c' },
        { label: 'Location', fieldName: 'Location__c' },
        { label: 'Start', fieldName: 'Start_Date__c', type: 'date' },
        { label: 'End', fieldName: 'End_Date__c', type: 'date' },
        { label: 'Status', fieldName: 'Status__c' }
    ];

    handleChange(event) {
        this.filter[event.target.dataset.field] = event.target.value;
    }

    async handleSearch() {
        this.results = await searchReservations(this.filter);
    }
}
