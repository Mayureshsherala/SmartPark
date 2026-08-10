import PDFDocument from 'pdfkit';

const money = (value) => `Rs. ${Number(value || 0).toFixed(2)}`;
const dateTime = (value) => value ? new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

function addHeader(doc, label) {
  doc.rect(0, 0, 612, 86).fill('#1B3A6B');
  doc.fillColor('#FFFFFF').fontSize(23).font('Helvetica-Bold').text('SmartPark', 48, 27);
  doc.fillColor('#9CE5DA').fontSize(10).font('Helvetica-Bold').text(label, 48, 61);
  doc.fillColor('#64748B').font('Helvetica').fontSize(9);
}

function detailRow(doc, label, value) {
  doc.fillColor('#64748B').font('Helvetica').fontSize(10).text(label, 48, doc.y, { continued: true });
  doc.fillColor('#17233A').font('Helvetica-Bold').text(value, { align: 'right' });
  doc.moveDown(0.45);
}

export function sendReceipt(res, session) {
  const doc = new PDFDocument({ margin: 48, size: 'A4' });
  const totalHours = Number(session.total_hours || ((new Date(session.exit_time) - new Date(session.entry_time)) / 3_600_000) || 0);
  const totalAmount = Number(session.total_amount || 0);
  const paid = session.payment_status === 'paid';

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=smartpark-receipt-${session.session_id}.pdf`);
  doc.pipe(res);
  addHeader(doc, paid ? 'PARKING PAYMENT RECEIPT' : 'PARKING PAYMENT SUMMARY');

  doc.y = 118;
  doc.fillColor('#17233A').font('Helvetica-Bold').fontSize(19).text(`Receipt #${session.session_id}`);
  doc.moveDown(0.35).fillColor('#64748B').font('Helvetica').fontSize(10).text(`Generated ${dateTime(new Date())}`);
  doc.moveDown(1.4);

  detailRow(doc, 'Customer', session.name || 'Parking customer');
  detailRow(doc, 'Vehicle', session.vehicle_number || 'Not provided');
  detailRow(doc, 'Parking slot', `P-${String(session.slot_number).padStart(2, '0')}`);
  detailRow(doc, 'Entry time', dateTime(session.entry_time));
  detailRow(doc, 'Exit time', dateTime(session.exit_time));
  detailRow(doc, 'Parking duration', `${totalHours.toFixed(2)} hour(s)`);

  doc.moveDown(0.75).moveTo(48, doc.y).lineTo(548, doc.y).strokeColor('#DCE3EC').stroke();
  doc.moveDown(1).fillColor('#17233A').font('Helvetica-Bold').fontSize(13).text('Billing summary');
  doc.moveDown(0.8);
  detailRow(doc, 'Base parking charge', money(session.base_amount));
  detailRow(doc, 'Overtime charge', money(session.overtime_amount));
  doc.moveTo(48, doc.y).lineTo(548, doc.y).strokeColor('#DCE3EC').stroke();
  doc.moveDown(0.7);
  doc.fillColor('#17233A').font('Helvetica-Bold').fontSize(14).text(paid ? 'Amount paid' : 'Amount due', 48, doc.y, { continued: true });
  doc.fillColor('#0D9488').text(money(totalAmount), { align: 'right' });
  doc.moveDown(1.1);
  detailRow(doc, 'Payment status', paid ? 'PAID' : 'PAYMENT DUE');
  detailRow(doc, 'Payment method', session.payment_mode ? session.payment_mode.toUpperCase() : 'Pending');

  doc.moveDown(1.4).roundedRect(48, doc.y, 500, 52, 8).fill('#E8F7F5');
  doc.fillColor('#087C72').font('Helvetica-Bold').fontSize(11).text(paid ? 'Thank you for choosing SmartPark.' : 'Please complete payment to close this parking record.', 64, doc.y + 13);
  doc.fillColor('#4A6675').font('Helvetica').fontSize(9).text('Keep this document for your parking records.', 64, doc.y + 4);
  doc.end();
}

export function sendBookingConfirmation(res, booking) {
  const doc = new PDFDocument({ margin: 48 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=smartpark-booking-${booking.booking_id}.pdf`);
  doc.pipe(res);
  doc.rect(0, 0, 612, 82).fill('#1B3A6B');
  doc.fillColor('#FFFFFF').fontSize(23).text('SmartPark System', 48, 28);
  doc.fillColor('#0D9488').fontSize(11).text('BOOKING CONFIRMATION', 48, 62);
  doc.moveDown(4).fillColor('#17233A').fontSize(18).text(`Booking #${booking.booking_id}`);
  doc.moveDown().fontSize(12);
  [['Customer', booking.name], ['Slot', `Slot P-${String(booking.slot_number).padStart(2, '0')}`], ['Vehicle', booking.vehicle_number || 'Not provided'], ['Expected arrival', new Date(booking.expected_arrival).toLocaleString('en-IN')], ['Duration', `${booking.duration_hours} hour(s)`], ['Amount', `Rs. ${Number(booking.amount_paid).toFixed(2)}`], ['Payment status', booking.payment_status.toUpperCase()], ['Booking status', booking.status.toUpperCase()]].forEach(([label, value]) => { doc.fillColor('#64748B').text(label); doc.fillColor('#17233A').font('Helvetica-Bold').text(value); doc.font('Helvetica').moveDown(.55); });
  doc.moveDown().fillColor('#0D9488').fontSize(13).text('Present this confirmation at your selected parking slot.');
  doc.moveDown().fillColor('#64748B').fontSize(10).text('Cancellations are available before arrival. Online-payment refunds are processed through the configured payment gateway.');
  doc.end();
}

export function sendBookingPaymentReceipt(res, booking) {
  const doc = new PDFDocument({ margin: 48, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=smartpark-payment-receipt-${booking.booking_id}.pdf`);
  doc.pipe(res);
  addHeader(doc, 'BOOKING PAYMENT RECEIPT');
  doc.y = 118;
  doc.fillColor('#17233A').font('Helvetica-Bold').fontSize(19).text(`Payment receipt #${booking.payment_id || booking.booking_id}`);
  doc.moveDown(0.35).fillColor('#64748B').font('Helvetica').fontSize(10).text(`Payment completed ${dateTime(booking.payment_time || new Date())}`);
  doc.moveDown(1.4);
  detailRow(doc, 'Booking reference', `#${booking.booking_id}`);
  detailRow(doc, 'Customer', booking.name || 'Parking customer');
  detailRow(doc, 'Vehicle', booking.vehicle_number || 'Not provided');
  detailRow(doc, 'Reserved parking slot', `P-${String(booking.slot_number).padStart(2, '0')}`);
  detailRow(doc, 'Expected arrival', dateTime(booking.expected_arrival));
  detailRow(doc, 'Booked duration', `${booking.duration_hours} hour(s)`);
  doc.moveDown(0.75).moveTo(48, doc.y).lineTo(548, doc.y).strokeColor('#DCE3EC').stroke();
  doc.moveDown(1);
  doc.fillColor('#17233A').font('Helvetica-Bold').fontSize(14).text('Amount paid', 48, doc.y, { continued: true });
  doc.fillColor('#0D9488').text(money(booking.amount_paid), { align: 'right' });
  doc.moveDown(1.1);
  detailRow(doc, 'Payment method', booking.payment_mode ? booking.payment_mode.toUpperCase() : 'DEMO UPI');
  detailRow(doc, 'Payment reference', booking.razorpay_id || `DEMO-UPI-${booking.booking_id}`);
  detailRow(doc, 'Reservation status', 'SLOT RESERVED');
  doc.moveDown(1.4).roundedRect(48, doc.y, 500, 52, 8).fill('#E8F7F5');
  doc.fillColor('#087C72').font('Helvetica-Bold').fontSize(11).text('Payment successful. Your parking slot is reserved.', 64, doc.y + 13);
  doc.fillColor('#4A6675').font('Helvetica').fontSize(9).text('Present this receipt when you arrive at the parking facility.', 64, doc.y + 4);
  doc.end();
}
