import Link from "next/link";

export default function NotFound() {
  return (
    <main className="page page-narrow">
      <div className="stack">
        <h1 className="display">Такой страницы нет</h1>
        <p className="p">
          Возможно, ссылка устарела или глава удалена. Всё, что вы добавляли, лежит в библиотеке.
        </p>
        <div className="row">
          <Link className="btn btn-primary" href="/">
            В библиотеку
          </Link>
          <Link className="btn" href="/add">
            Добавить главу
          </Link>
        </div>
      </div>
    </main>
  );
}
