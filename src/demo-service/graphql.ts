import fs from 'node:fs';
import { buildSchema, graphql, GraphQLSchema } from 'graphql';
import { CONTRACT_FILE } from '../shared/paths';
import { CreateReservationInput, CustomerInput, PaymentInput } from './reservation-validator';
import { ModifyReservationInput, ReservationService } from './reservation-service';

let schema: GraphQLSchema | null = null;

export function contractSchema(): GraphQLSchema {
  schema ??= buildSchema(fs.readFileSync(CONTRACT_FILE, 'utf8'));
  return schema;
}

export function rootValue(service: ReservationService) {
  return {
    health: () => 'ok',
    locations: () => service.locations(),
    reservation: ({ confirmationNumber }: { confirmationNumber: string }) => service.find(confirmationNumber),
    searchReservations: ({ filter }: { filter: Parameters<ReservationService['search']>[0] }) => service.search(filter),
    availability: (a: { locationId: string; resourceType: string; startDate: string; endDate: string }) => service.availability(a.locationId, a.resourceType, a.startDate, a.endDate),
    validateCustomer: ({ customer }: { customer: CustomerInput }) => service.validateCustomer(customer),
    validatePayment: ({ payment }: { payment: PaymentInput }) => service.validatePayment(payment),
    createReservation: ({ input }: { input: CreateReservationInput }) => service.createReservation(input),
    modifyReservation: ({ input }: { input: ModifyReservationInput }) => service.modifyReservation(input),
    cancelReservation: (a: { confirmationNumber: string; reason?: string }) => service.cancelReservation(a.confirmationNumber, a.reason),
  };
}

export async function execute(service: ReservationService, query: string, variables?: Record<string, unknown>, operationName?: string) {
  return graphql({ schema: contractSchema(), source: query, rootValue: rootValue(service), variableValues: variables, operationName });
}
