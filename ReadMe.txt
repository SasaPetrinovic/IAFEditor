A sta mislis o Visual Studio Code?

VS Code mi deluje kao najbolji “neinvazivni” pravac: ne diramo IAF, nego pravimo moderan editor/preglednik oko postojećeg koda. Proveriću samo aktuelne mogućnosti VS Code ekstenzija, pa ću ti dati konkretan predlog arhitekture.



Mislim da je Visual Studio Code odličan izbor za ovo — verovatno bolji od pravljenja posebnog WinForms editora u prvoj fazi.

Ne bih ga koristio kao zamenu za IAF generator, nego kao spoljni pametni editor za IAF kod:

IAF editor ostaje za unos u generator.
VS Code koristimo za čitanje, formatiranje, proveru i razumevanje koda.

Kod koji si poslao je baš tipičan primer gde bi VS Code pomogao: ima više nivoa IF, DO_WHILE, ELSE, END_IF, END_DO, dosta EXECSQL update IPSKOP, i deo gde se čuvaju pomoćni nizovi $ozmm, $pomk, $clan, $proc, pa se posle radi preračun grupe.

Zašto baš VS Code

VS Code ekstenzije mogu da dodaju podršku za novi jezik: syntax highlighting, komentare, folding, indentation, word pattern i slično. To je baš ono što nama treba za IAF.

Takođe, VS Code ekstenzija može da prijavljuje greške kao diagnostics, doda folding, breadcrumbs, outline, hover objašnjenja i IntelliSense. Za ozbiljniju varijantu postoji i Language Server pristup, gde možeš dobiti autocomplete, proveru grešaka i jump-to-definition.

Znači, tehnički gledano, VS Code je skoro idealan za “IAF pametni editor”.

Kako bih ja to napravio

Ne bih odmah pravio kompleksan language server. Išao bih u tri koraka.

Faza 1 — jednostavna IAF ekstenzija

Prva verzija ekstenzije:

IAF Language Support

Funkcije:

- prepoznaje .iaf, .iaftxt, .iafcode fajlove
- boji ključne reči: IF, ELSE, END_IF, DO_WHILE, END_DO, SELECT_ALL, END_SELECT
- boji EXECSQL, READ, UPDATE, WRITE, COMMIT, PAUSE, CHECK, ERRMSG
- boji lokalne promenljive koje počinju sa $
- boji komentare koji počinju sa ! ili !!
- omogućava folding preko !#region / !#endregion
- dodaje snippets za IF, DO_WHILE, EXECSQL UPDATE

Ovo može relativno brzo da se napravi i već bi bilo korisno.

Na primer, u kodu bi mogao da imaš:

!#region SNIMANJE TRENUTNOG REDA
if Record IPSKOP Found
    ...
end_if
!#endregion

I VS Code bi ti dao plusić za sklapanje tog regiona.

Faza 2 — pravi IAF folding po IF/END_IF

Ovo je ono što tebi zapravo najviše treba.

Ekstenzija bi analizirala kod i pravila folding opsege:

if ... end_if
if ... else ... end_if
do_while ... end_do
select_all ... end_select
procedure ... end_procedure

Tada bi imao plusiće direktno na granama:

if ipskop.kop_oznamm in ("P";"Z";"C";"R";"G";"H")
    ...
end_if

I mogao bi da sklopiš celu logiku za oznake P/Z/C/R/G/H.

Ovo je mnogo bolje nego ručno dodavati !#region svuda.

Faza 3 — diagnostics i block tree

Ovo bi bila najvrednija faza.

Kada otvoriš IAF kod u VS Code, sa strane dobiješ greške i upozorenja:

END_IF bez otvorenog IF-a
DO_WHILE nije zatvoren
ELSE bez IF-a
SELECT_ALL nije zatvoren
prevelika dubina ugnježdenja: 14
prazan ELSE blok
moguće pogrešno END_If / End_IF, proveriti stil

Za tvoj konkretan kod, alat bi mogao da prikaže stablo:

LineEndingAction
├── IF Record IPSKOP Found
│   ├── IF promenjene količine
│   └── IF $UKUP > 0
├── IF $imasta > 0
├── IF oznaka P/Z/C/R/G/H
│   └── IF red promenjen ili oznaka G
│       ├── IF toplana
│       ├── DO_WHILE pronađi G
│       ├── DO_WHILE saberi prethodne stavke
│       └── DO_WHILE preraspodela do glavnog reda
└── IF limit po članu

To je ono što sada ručno pokušavaš da vidiš u glavi.

Najbolja arhitektura za nas

Pošto ti radiš C#, ja ne bih svu logiku pisao u TypeScript-u samo zbog VS Code-a.

Napravio bih ovako:

1. Iaf.Parser.csproj
   - C# biblioteka
   - čita IAF kod
   - vraća blokove, greške, indentaciju

2. Iaf.CodeTool.exe
   - komandna linija
   - format
   - analyze
   - html
   - json

3. VS Code extension
   - TypeScript tanki omotač
   - poziva Iaf.CodeTool.exe
   - prikazuje greške, folding, outline

Zašto ovako?

Zato što isti parser posle možeš koristiti i u:

WinForms IAF Analyzer
HTML dokumentaciji
PoIS internom alatu
AI pomoćniku za prevođenje IAF -> C#
Git pre-commit proveri

VS Code ekstenzija bi bila samo jedan način prikaza.

Kako bi izgledao radni proces

Praktično:

1. Iz IAF editora kopiraš LineEndingAction kod.
2. Snimiš ga kao:
   Ocitanja.LineEndingAction.iaf
3. Otvoriš u VS Code.
4. Pokreneš:
   IAF: Format Document
5. Pogledaš folding i block tree.
6. Dodaš novu funkcionalnost.
7. Pokreneš:
   IAF: Validate Blocks
8. Kopiraš kod nazad u IAF editor.

Kasnije možemo napraviti i alat koji čuva original i formatiranu verziju:

Ocitanja.LineEndingAction.original.iaf
Ocitanja.LineEndingAction.formatted.iaf
Ocitanja.LineEndingAction.blocks.html
Šta bih odmah dodao za ovaj tvoj slučaj

Za LineEndingAction kod, meni bi najkorisnije bile ove komande u VS Code-u:

IAF: Format Current File
IAF: Show Block Tree
IAF: Add END_IF Comments
IAF: Validate IF/END_IF
IAF: Export HTML With Folding
IAF: Extract Selected Block To Procedure Draft

Posebno korisno:

END_IF  !! if $ozmm($i) = "G"
END_DO  !! do_while $I <= $K
END_IF  !! if ipskop.kop_oznamm in ("P";"Z";"C";"R";"G";"H")

To ne moraš ručno da pišeš. Alat može sam da doda komentare u posebnoj “annotated” verziji.

Moj zaključak

Da, VS Code je odličan pravac.

Ne bih pravio kompletan novi editor. Krenuo bih sa:

IAF Language Support ekstenzija za VS Code
+
C# parser/formatter kao zajedničko jezgro

To bi ti odmah rešilo “plusiće”, uvlačenje, pregled blokova i greške u zatvaranju IF/END_IF. A kasnije isti alat može da preraste u ozbiljan IAF Analyzer i pomoćnika za postepeno prevođenje delova PoIS-a u C#.