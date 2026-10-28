import { APP_VERSION } from '../lib/version';

/** Faixa no rodapé com o nome e a versão do sistema. */
export function SystemFooter() {
  return <footer className="sys-footer"><span>Central<span className="brand-dot">.</span>PDV</span><span className="sys-sep" />versão {APP_VERSION}<span className="sys-sep" /><a href="/">Conheça o sistema</a></footer>;
}
