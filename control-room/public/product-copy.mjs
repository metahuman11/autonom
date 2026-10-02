// Website presentation only. No instructions, financial settings or simulated data.
import {cinemaCopy} from './cinema-copy.mjs?v=unified-20260930';
import {copy, languageOf} from './explore-i18n.mjs?v=unified-20260930';
const rows={
 en:['Your community.','Built into action.','Explore projects.','A workspace with a shared direction.','The details behind the work.','Start with a shared idea.','Explore the system','Illustrated workflow','Pause animation','Play animation'],
 es:['Tu comunidad.','Ideas en acción.','Explora proyectos.','Un espacio de trabajo con una dirección común.','Los detalles detrás del trabajo.','Empieza con una idea compartida.','Explora el sistema','Proceso ilustrado','Pausar animación','Reproducir animación'],
 fr:['Votre communauté.','Des idées en action.','Découvrez les projets.','Un espace de travail, une direction commune.','Les détails du fonctionnement.','Partez d’une idée commune.','Explorez le système','Processus illustré','Suspendre l’animation','Lancer l’animation'],
 de:['Deine Community.','Ideen werden Arbeit.','Projekte entdecken.','Eine Arbeitsumgebung mit gemeinsamer Richtung.','So funktioniert die Arbeit.','Beginnt mit einer gemeinsamen Idee.','Das System erkunden','Veranschaulichter Ablauf','Animation pausieren','Animation starten'],
 pt:['A tua comunidade.','Ideias em ação.','Explora projetos.','Um espaço de trabalho com uma direção comum.','Os detalhes por trás do trabalho.','Começa com uma ideia partilhada.','Explora o sistema','Processo ilustrado','Pausar animação','Reproduzir animação'],
 it:['La tua comunità.','Le idee in azione.','Esplora i progetti.','Uno spazio di lavoro con una direzione comune.','I dettagli del lavoro.','Inizia con un’idea condivisa.','Esplora il sistema','Processo illustrato','Pausa animazione','Avvia animazione'],
 ja:['あなたのコミュニティ。','アイデアを行動へ。','プロジェクトを探す。','みんなで方向を決める作業スペース。','仕事の仕組みを知る。','共通のアイデアから始めよう。','仕組みを見る','ワークフローの図解','アニメーションを一時停止','アニメーションを再生'],
 ko:['당신의 커뮤니티.','아이디어를 행동으로.','프로젝트 둘러보기.','함께 방향을 정하는 작업 공간.','작업의 원리를 알아보세요.','공유하는 아이디어에서 시작하세요.','시스템 살펴보기','워크플로 예시','애니메이션 일시 정지','애니메이션 재생'],
 zh:['你的社区。','让想法化为行动。','探索项目。','共同决定方向的工作空间。','了解工作背后的细节。','从共同的想法开始。','探索系统','流程示意','暂停动画','播放动画'],
 ar:['مجتمعك.','أفكار تتحول إلى عمل.','استكشف المشاريع.','مساحة عمل باتجاه مشترك.','التفاصيل وراء العمل.','ابدأ بفكرة مشتركة.','استكشف النظام','رسم توضيحي لسير العمل','إيقاف الحركة مؤقتًا','تشغيل الحركة']
};
const sceneRows={
 en:['Drag to explore','Reset view','Arrow keys rotate. Home resets the view.','Interactive Autonom AI workspace. Drag to rotate; use arrow keys or Home to reset.'],
 es:['Arrastra para explorar','Restablecer vista','Las flechas giran. Inicio restablece la vista.','Espacio de IA Autonom interactivo. Arrastra o usa las flechas para girar; Inicio restablece la vista.'],
 fr:['Glissez pour explorer','Réinitialiser la vue','Les flèches font tourner. Début réinitialise la vue.','Espace IA Autonom interactif. Glissez ou utilisez les flèches pour tourner ; Début réinitialise la vue.'],
 de:['Ziehen und erkunden','Ansicht zurücksetzen','Pfeiltasten drehen. Pos1 setzt die Ansicht zurück.','Interaktiver Autonom-KI-Arbeitsplatz. Zum Drehen ziehen oder Pfeiltasten nutzen; Pos1 setzt die Ansicht zurück.'],
 pt:['Arrasta para explorar','Repor vista','As setas rodam. Home repõe a vista.','Espaço de IA Autonom interativo. Arrasta ou usa as setas para rodar; Home repõe a vista.'],
 it:['Trascina per esplorare','Ripristina vista','Le frecce ruotano. Home ripristina la vista.','Spazio IA Autonom interattivo. Trascina o usa le frecce per ruotare; Home ripristina la vista.'],
 ja:['ドラッグして見る','表示をリセット','矢印キーで回転。Homeで表示をリセット。','Autonom AIの対話型ワークスペース。ドラッグまたは矢印キーで回転し、Homeで表示をリセット。'],
 ko:['드래그하여 둘러보기','시점 초기화','방향키로 회전합니다. Home으로 시점을 초기화합니다.','Autonom AI 인터랙티브 작업 공간. 드래그나 방향키로 회전하고 Home으로 시점을 초기화하세요.'],
 zh:['拖动以探索','重置视角','方向键旋转，Home键重置视角。','Autonom AI互动工作空间。拖动或使用方向键旋转，Home键重置视角。'],
 ar:['اسحب للاستكشاف','إعادة ضبط العرض','مفاتيح الأسهم للتدوير. Home لإعادة ضبط العرض.','مساحة عمل ذكاء اصطناعي تفاعلية من Autonom. اسحب أو استخدم الأسهم للتدوير، وHome لإعادة ضبط العرض.']
};
const sceneKeys=['sceneDrag','sceneReset','sceneKeys','sceneCanvas'];
const keys=['heroTitle','heroAccent','discoveryTitle','systemTitle','faqTitle','closeTitle','systemAction','illustration','pause','play'];
export const productCopy=Object.freeze(Object.fromEntries(Object.entries(rows).map(([lang,v])=>[lang,Object.freeze({...cinemaCopy[lang],...copy[lang],...Object.fromEntries(sceneKeys.map((key,i)=>[key,sceneRows[lang][i]])),...Object.fromEntries(keys.map((key,i)=>[key,v[i]]))})])));
export const getProductCopy=locale=>productCopy[languageOf(locale)];
