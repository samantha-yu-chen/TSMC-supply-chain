const companies = {
  mediatek: { number: '01', role: 'IC 設計', name: '聯發科', english: 'MediaTek', description: '以無晶圓廠模式設計系統單晶片，涵蓋手機、連網與其他應用。', ticker: '2454', market: 'TWSE', source: 'https://www.mediatek.com/company/discover' },
  globalwafers: { number: '02', role: '矽晶圓', name: '環球晶', english: 'GlobalWafers', description: '製造半導體用矽晶圓，提供晶片製程所需的基材。', ticker: '6488', market: 'TPEx', source: 'https://www.gw-semi.com/products/' },
  tsmc: { number: '03', role: '晶圓製造', name: '台積電', english: 'TSMC', description: '專注替客戶製造晶片的晶圓代工。', ticker: '2330', market: 'TWSE', source: 'https://www.tsmc.com/english/aboutTSMC/company_profile' },
  unimicron: { number: '04', role: 'IC 載板', name: '欣興', english: 'Unimicron', description: '製造連接晶片與電路板的載板，也提供其他 PCB 產品。', ticker: '3037', market: 'TWSE', source: 'https://www.uniflex.com.tw/esg/en/product01.html' },
  ase: { number: '05', role: '封裝與測試', name: '日月光投控', english: 'ASE Technology Holding', description: '旗下事業提供晶片封裝、測試與系統整合服務。', ticker: '3711', market: 'TWSE', source: 'https://www.aseglobal.com/about/' }
};

function selectCompany(id) {
  const company = companies[id];
  if (!company) return;
  document.querySelectorAll('.step').forEach(button => {
    const active = button.dataset.company === id;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const values = {
    'detail-index': `角色 ${company.number} / 05`,
    'detail-role': company.role,
    'detail-name': company.name,
    'detail-english': company.english,
    'detail-description': company.description,
    'detail-ticker': company.ticker,
    'detail-market': company.market
  };
  for (const [id, value] of Object.entries(values)) document.getElementById(id).textContent = value;
  document.getElementById('detail-source').href = company.source;
}

document.querySelectorAll('.step').forEach(button => button.addEventListener('click', () => selectCompany(button.dataset.company)));
document.querySelectorAll('[data-jump]').forEach(link => link.addEventListener('click', () => selectCompany(link.dataset.jump)));
