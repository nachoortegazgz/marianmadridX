import test from 'node:test';
import assert from 'node:assert/strict';

const { mocks, wixDataMock } = await import('./loader.mjs');
const IC = await import('backend/internalConfig');
const { executeBookingSaga } = await import('backend/booking/bookingSaga');

const SERVICE_SIMPLE = '00000000-0000-4000-8000-000000000101';
const SERVICE_DUAL = '00000000-0000-4000-8000-000000000102';
const SERVICE_PHASE2 = '00000000-0000-4000-8000-000000000103';
const RESOURCE_ID = '00000000-0000-4000-8000-000000000201';
const SCHEDULE_ID = '00000000-0000-4000-8000-000000000202';
const BOOKING_IDS = [
  '00000000-0000-4000-8000-000000000301',
  '00000000-0000-4000-8000-000000000302',
];
const DATE = '2026-10-08';
const F1_START = `${DATE}T10:00:00`;
const F1_END = `${DATE}T10:30:00`;
const F2_START = `${DATE}T11:00:00`;
const F2_END = `${DATE}T11:30:00`;

let bookingRequests = [];
let checkoutRequests = [];
let nextBooking = 0;

function serviceRecord({ serviceId, slug, dual = false, hidden = false }) {
  return {
    _id: serviceId,
    serviceId,
    slug,
    title: slug,
    sku: slug,
    status: 'ACTIVE',
    price: 50,
    currency: 'EUR',
    locationId: IC.SDK_CONFIG.LOCATION_ID,
    availableStaff: [RESOURCE_ID],
    phase1Duration: 30,
    exposureDuration: dual ? 30 : 0,
    phase2Duration: dual ? 0 : 0,
    totalDuration: 30,
    allowCombine: dual,
    linkedPhases: dual ? SERVICE_PHASE2 : null,
    clientHidden: hidden,
  };
}

function resetMocks(records) {
  wixDataMock._reset();
  wixDataMock._seed(IC.BUSINESS_COLLECTIONS.SERVICIOS_CATALOGO, records);
  wixDataMock._seed(IC.BUSINESS_COLLECTIONS.CITAS_F2, []);
  wixDataMock._seed(IC.BUSINESS_COLLECTIONS.MAPA_STAFF, [{
    _id: RESOURCE_ID,
    resourceId: RESOURCE_ID,
    memberId: '00000000-0000-4000-8000-000000000203',
    rolBookings: 'STAFF',
    rolWebsite: 'STAFF',
    staffName: 'Profesional de prueba',
    scheduleId: SCHEDULE_ID,
    traceId: 'test-staff',
  }]);
  wixDataMock._seed(IC.OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, []);

  bookingRequests = [];
  checkoutRequests = [];
  nextBooking = 0;

  mocks.bookings.createBooking = async (request) => {
    bookingRequests.push(request);
    const id = BOOKING_IDS[nextBooking++];
    return { booking: { id, revision: 1, status: 'PENDING' } };
  };
  mocks.bookings.cancelBooking = async () => ({ status: 'CANCELED' });
  mocks.bookings.confirmOrDeclineBooking = async (id) => ({
    booking: { id, bookingStatus: 'CONFIRMED' },
  });
  mocks.availabilityTimeSlots.getAvailabilityTimeSlot = async (request) => ({
    timeSlot: {
      serviceId: request.serviceId,
      localStartDate: request.localStartDate,
      localEndDate: request.localEndDate,
      bookable: true,
      resourceId: RESOURCE_ID,
      scheduleId: SCHEDULE_ID,
      locationId: IC.SDK_CONFIG.LOCATION_ID,
      location: { id: IC.SDK_CONFIG.LOCATION_ID },
      availableResources: [{
        resourceTypeId: IC.API.STAFF_RESOURCE_TYPE_ID,
        resources: [{ id: RESOURCE_ID }],
      }],
    },
  });
  mocks.checkout.createCheckout = async (request) => {
    checkoutRequests.push(request);
    return { _id: 'checkout-test-001' };
  };
  mocks.checkout.getCheckoutUrl = async () => 'https://checkout.example.test/session';
}

async function runOnline(serviceId, slotF1, slotF2) {
  return executeBookingSaga({
    serviceId,
    resourceId: RESOURCE_ID,
    email: 'booking-test@example.test',
    firstName: 'Prueba',
    lastName: 'Automatica',
    paymentMethod: 'ONLINE',
    slotF1,
    ...(slotF2 ? { slotF2 } : {}),
    traceId: `offline-test-${serviceId.slice(-2)}`,
  });
}

test('online simple creates one independent booking and one checkout line', async () => {
  resetMocks([serviceRecord({ serviceId: SERVICE_SIMPLE, slug: 'simple' })]);

  const result = await runOnline(SERVICE_SIMPLE, {
    localStartDate: F1_START,
    localEndDate: F1_END,
  });

  assert.equal(result.status, 'SUCCESS', JSON.stringify(result.error));
  assert.equal(result.data.requiresPayment, true);
  assert.equal(result.data.checkoutUrl, 'https://checkout.example.test/session');
  assert.equal(bookingRequests.length, 1);
  assert.equal(checkoutRequests.length, 1);
  assert.equal(checkoutRequests[0].lineItems.length, 1);
  assert.ok(bookingRequests[0].bookedEntity.slot);
  assert.equal(bookingRequests[0].bookedEntity.services, undefined);

  const citas = wixDataMock._store.get(IC.BUSINESS_COLLECTIONS.CITAS_F2) || [];
  assert.equal(citas.length, 1);
  assert.equal(citas[0].bookingType, IC.BOOKING_TYPE.SIMPLE);
});

test('online dual uses two bookings and leaves a positive 30-minute staff gap', async () => {
  resetMocks([
    serviceRecord({ serviceId: SERVICE_DUAL, slug: 'dual', dual: true }),
    // The linked phase is intentionally hidden from the public catalog.
    serviceRecord({ serviceId: SERVICE_PHASE2, slug: 'dual-phase-2', hidden: true }),
  ]);

  const result = await runOnline(SERVICE_DUAL, {
    localStartDate: F1_START,
    localEndDate: F1_END,
  }, {
    localStartDate: F2_START,
    // F2 end is derived from the linked service's 30-minute duration.
  });

  assert.equal(result.status, 'SUCCESS', JSON.stringify(result.error));
  assert.equal(result.data.requiresPayment, true);
  assert.equal(bookingRequests.length, 2);
  assert.equal(checkoutRequests.length, 1);
  assert.equal(checkoutRequests[0].lineItems.length, 2);

  const f1 = bookingRequests[0].bookedEntity.slot;
  const f2 = bookingRequests[1].bookedEntity.slot;
  assert.equal(f1.serviceId, SERVICE_DUAL);
  assert.equal(f2.serviceId, SERVICE_PHASE2);
  assert.equal(bookingRequests[0].bookedEntity.services, undefined);
  assert.equal(bookingRequests[1].bookedEntity.services, undefined);
  assert.equal(f1.resource.id, RESOURCE_ID);
  assert.equal(f2.resource.id, RESOURCE_ID);

  const gapMinutes = (new Date(f2.startDate).getTime() - new Date(f1.endDate).getTime()) / 60000;
  assert.equal(gapMinutes, 30);
  assert.ok(gapMinutes > 0, 'F1 y F2 deben dejar libre al profesional durante el gap');

  const citas = wixDataMock._store.get(IC.BUSINESS_COLLECTIONS.CITAS_F2) || [];
  assert.equal(citas.length, 2);
  assert.deepEqual(
    citas.map((item) => item.bookingType).sort(),
    [IC.BOOKING_TYPE.DUAL_F1, IC.BOOKING_TYPE.DUAL_F2].sort(),
  );
  assert.equal(citas[0].pairToken, citas[1].pairToken);
});
