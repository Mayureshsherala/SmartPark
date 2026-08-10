export const secondsPerHour = () => Number(process.env.SECONDS_PER_HOUR || 5);

export function calculateBill({ entryTime, exitTime = new Date(), registeredHours, passType = 'normal', normalRate = 20, overtimeRate = 40 }) {
  const elapsedSeconds = Math.max(0, (new Date(exitTime) - new Date(entryTime)) / 1000);
  const totalHours = elapsedSeconds / secondsPerHour();
  const roundedHours = Math.max(1, Math.ceil(totalHours));
  const registered = Math.max(1, Number(registeredHours || 1));
  const overtimeHours = Math.max(0, Math.ceil(totalHours - registered));
  if (passType === 'monthly') return { totalHours, roundedHours, overtimeHours: 0, baseAmount: 0, overtimeAmount: 0, totalAmount: 0 };
  const baseAmount = registered * Number(normalRate);
  const overtimeAmount = overtimeHours * Number(overtimeRate);
  return { totalHours, roundedHours, overtimeHours, baseAmount, overtimeAmount, totalAmount: baseAmount + overtimeAmount };
}
