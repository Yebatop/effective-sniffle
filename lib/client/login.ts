/** Слова для экрана входа по ответу {ok:false, code, message}. */

export const NO_PASSWORD_TEXT =
  "Пароль не задан. В Vercel → проект → Settings → Environment Variables добавьте APP_PASSWORD и перевыложите";

export function loginProblemText(code: string | undefined, message: string | undefined): string {
  if (code === "no_password") return NO_PASSWORD_TEXT;
  if (message && message.trim()) return message.trim();
  if (code === "too_many" || code === "rate_limit") return "Слишком много попыток. Подождите немного и попробуйте снова.";
  return "Пароль не подошёл. Проверьте раскладку и попробуйте ещё раз.";
}
