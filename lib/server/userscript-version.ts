/**
 * Версия кнопки для сайтов (@version). Менеджер скриптов обновляет скрипт,
 * только если версия на сервере БОЛЬШЕ установленной, — поэтому она должна
 * только расти. Раньше она бралась из хеша содержимого (1.0.<число>), и
 * новая сборка могла получить меньшее число — тогда «обновлений не найдено».
 *
 * Теперь — время сборки: 2.ГГГГММДД.ЧЧММСС (UTC). Старшая цифра 2 больше
 * любой прежней 1.0.x, а время каждой следующей выкладки — больше прошлого.
 */
export function userscriptVersion(builtAt: number): string {
  const d = new Date(builtAt > 0 ? builtAt : 0);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const day = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  // Ведущие нули менеджер отбрасывает при сравнении — «000102» сравнится как 102, это верно.
  return `2.${day}.${Number(time)}`;
}
