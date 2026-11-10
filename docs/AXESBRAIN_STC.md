# Formato `.stc` e macchina virtuale AxesBrain (bozza 0.2)

Stato: **bozza da rivedere** con Andrea, 09/11/2026. Scritta da Claude. Versione del formato **0.2**: frame
per tutte le POU con immagine iniziale (`FRMI`), STRING, STRUCT, enum, puntatori, array multidimensionali e di FB,
parametri per indirizzo, nuovi codici operativi (§7.7); cosa cambia rispetto alla 0.1 è in §13.
Questo documento fa parte del fork GPL `AxesBrain-ST-Compiler` ed è pubblico apposta: il formato `.stc` è una
specifica indipendente che qualunque compilatore può generare e qualunque VM può eseguire (vedi l'analisi di
fattibilità in AxesBrainSRV, §11, regola 3). La VM di AxesBrainSRV è un'implementazione separata e non contiene codice
di questo repository.

## 1. Obiettivi e vincoli

- Eseguire programmi IEC 61131-3 (ST, e IL tramite la traduzione IL → ST già presente) dentro AxesBrainSRV, a
  scansione ciclica sul segnale del driver (`AbtDrvPlcSignalEvt`, 1 ms o 250 µs), nel thread `ThreadTaskST` a
  priorità `HIGHEST`.
- Nessuna allocazione di memoria durante la scansione: tutta la memoria è decisa dal compilatore e allocata al
  caricamento.
- Nessun parsing a run-time: il `.stc` contiene solo indirizzi, indici e costanti già risolti.
- Errori del programma (indice fuori limite, divisione per zero, ciclo infinito) fermano il task, mai SRV.
- Debug: breakpoint per riga, lettura e forzatura delle variabili per nome, impronta MD5 dei sorgenti.
- Stessa semantica del back-end C++ di STruC++, verificata con prove di confronto ciclo per ciclo (§10).

## 2. Il back-end nel compilatore

- Nuovo back-end in `src/backend-stc/`, file nostri, attivato da un'opzione (`--target stc`). Riceve lo stesso
  `CompilationUnit` già analizzato e le stesse tabelle dei simboli che `compile()` passa a `CodeGenerator`
  (`src/index.ts`, ~riga 754). Il front-end e la semantica non si toccano.
- I file del back-end portano, oltre alla GPL-3.0-only, il permesso aggiuntivo sull'output (§11.3 punto 4
  dell'analisi): i pezzi fissi copiati nel `.stc` non vincolano il programma dell'utente.
- Uscite del compilatore: `programma.stc` e un file di diagnostica JSON (errori con file:riga:colonna, già
  prodotti dal front-end).

## 3. Contenitore del file

Binario, little-endian, allineamento a 8 byte delle sezioni.

**Intestazione** (64 byte):

| Campo | Tipo | Note |
|---|---|---|
| magia | 4 byte | `ABST` |
| versione formato | u16 maggiore, u16 minore | la VM rifiuta un maggiore diverso |
| flag | u32 | bit 0: contiene debug |
| md5 sorgente | 16 byte | MD5 del file sorgente principale (il primo `.st` sulla riga di comando), byte per byte come su disco; le librerie (`ablib.st`, `--lib`) hanno il loro MD5 nella sezione `SRCS` |
| versione compilatore | u32 | |
| numero sezioni | u32 | |
| riservato | resto | a zero |

**Tabella delle sezioni**: per ogni sezione `id` (4 caratteri), offset u32, lunghezza u32.

| Sezione | Contenuto |
|---|---|
| `STRS` | tabella delle stringhe (nomi, letterali), UTF-8, indicizzata |
| `TYPE` | tabella dei tipi (§4) |
| `CONS` | costanti grandi (LREAL, LINT, stringhe letterali, inizializzatori di array/struct) |
| `DATA` | dimensione e immagine iniziale del segmento globale (§5) |
| `POUS` | funzioni, function block, programmi: codice, dimensioni, variabili (§6) |
| `CODE` | bytecode di tutte le POU (§7) |
| `FRMI` | immagine iniziale del frame di ogni POU (§6.1), dalla versione 0.2 |
| `TASK` | task e programmi associati (§8) |
| `IOMP` | variabili con indirizzo `%I/%Q/%M` (§9) |
| `NATV` | funzioni native richieste a SRV, per nome e firma (§7.6) |
| `DBUG` | simboli e mappa codice → riga:colonna (§10), opzionale |
| `RETN` | elenco delle variabili RETAIN, opzionale |
| `SRCS` | altri sorgenti compilati (librerie, file I/O, archivi `--lib`): `u32 n; {str percorso assoluto, u8[16] md5}*`, opzionale (10/11/2026) |

La VM ignora le sezioni che non conosce (compatibilità in avanti).

## 4. Tipi

Ogni tipo ha un indice nella tabella `TYPE`. Rappresentazione in memoria:

| IEC | Memoria |
|---|---|
| BOOL | 1 byte, 0 o 1 |
| SINT, USINT, BYTE, CHAR | 1 byte |
| INT, UINT, WORD, WCHAR | 2 byte |
| DINT, UDINT, DWORD, REAL | 4 byte |
| LINT, ULINT, LWORD, LREAL | 8 byte |
| TIME, LTIME, TOD, DT e varianti L | 8 byte, nanosecondi con segno (TOD da mezzanotte, DT dal 1970) |
| DATE | 8 byte, **giorni** dal 1970-01-01 (come STruC++) |
| STRING(n) | intestazione di 4 byte (`u16` capacità n, `u16` 0) **prima** dei caratteri, poi n+1 byte terminati da NUL; n predefinito 254 |
| WSTRING(n) | non ancora |
| enum | intero della dimensione del tipo base (predefinito INT) |
| ARRAY | elementi contigui, per righe (l'ultimo indice varia più in fretta) |
| STRUCT | campi contigui allineati alla loro dimensione; dimensione arrotondata al massimo allineamento |
| FB | istanza: input, output, VAR, VAR_IN_OUT (come indirizzi); le VAR_TEMP stanno nel frame |
| REF_TO / POINTER / REFERENCE_TO | 8 byte: indirizzo VM (§5.2); `SIZEOF` di un puntatore vale 4 (§12) |

**Indirizzo di una STRING**: è quello del primo carattere, come in CODESYS, perché OSCAT legge e scrive le
stringhe con `ADR()` e puntatori a BYTE. La lunghezza è la posizione del primo NUL (al massimo n); la capacità è
nei 4 byte prima. Assegnamenti e funzioni troncano alla capacità della destinazione.

Aritmetica intera: **complemento a due come il C++ generato su x64**: gli operandi più stretti di 32 bit sono
promossi a `int`, il risultato è troncato a 32 bit (o 64 per LINT/ULINT) e poi alla dimensione della variabile
che lo riceve. A parità di dimensione vince il tipo senza segno. Verificato con le prove di confronto (§13).

Reali: un letterale senza tipo (`0.1`) è LREAL; un'operazione tra REAL resta a precisione singola (arrotondata
dopo ogni operazione), tra REAL e LREAL è a precisione doppia, come il C++ `float`/`double`. `REAL_TO_INT` e
simili arrotondano lontano da zero (`std::round`), l'assegnamento implicito reale → intero tronca. Divisione
reale per zero: ±INF o NaN (IEEE).

Conversioni dei tipi di tempo verso numeri e ritorno (come CODESYS e STruC++): TIME e TOD in millisecondi,
DT e DATE in secondi.

## 5. Modello di memoria

### 5.1 Segmenti

- **Globale (G)**: un blocco unico allocato al caricamento. Contiene `VAR_GLOBAL`, istanze dei PROGRAM (una per
  istanza dichiarata in CONFIGURATION), variabili con indirizzo, dentro le istanze tutte le istanze di FB, e in
  fondo le costanti STRING usate dal codice.
  Le istanze di FB sono parte dei dati del proprietario, come in IEC; un FB dichiarato nelle VAR di una FUNCTION
  vive nel frame della FUNCTION (come in CODESYS, si reinizializza a ogni chiamata).
- **Stack delle chiamate**: un blocco per task (256 KB nella VM di prova; la ricorsione è vietata dalla norma).
  **Ogni POU ha un frame**, creato a ogni chiamata copiandoci l'immagine iniziale della sezione `FRMI` (§6.1):
  FUNCTION (risultato, parametri, locali, `VAR_TEMP`), FB e PROGRAM (`VAR_TEMP`), più i temporanei nascosti del
  compilatore. Le `VAR_TEMP` ripartono quindi dal valore iniziale a ogni chiamata.
- **Pila degli operandi**: slot da 8 byte, profondità massima calcolata dal compilatore per POU.

### 5.2 Indirizzi

Un indirizzo VM è un intero a 64 bit: segmento negli 8 bit alti (1 globale, 2 stack) + offset; 0 è `NULL` e non
è mai valido (trappola 4). Gli indirizzi sono interni alla VM: non vanno salvati né confrontati tra due caricamenti. I puntatori, i
`REF_TO`, i parametri `VAR_IN_OUT` e quelli passati per indirizzo (§6.2) usano questi indirizzi; la VM verifica
segmento e limiti a ogni accesso indiretto. L'aritmetica dei puntatori conta **byte**, come CODESYS
(`ADR(a[2]) + 2` con `a : ARRAY OF INT` punta ad `a[3]`).

### 5.3 Basi degli accessi diretti

Le istruzioni di caricamento e scrittura hanno una base e un offset immediato:

| Base | Significato |
|---|---|
| `G` | segmento globale, offset assoluto |
| `F` | frame corrente sullo stack |
| `I` | istanza corrente (il `this` del FB o del PROGRAM in esecuzione) |
| `P` | indirizzo calcolato in cima alla pila (accesso indiretto) |

## 6. Unità di programma (`POUS`)

Per ogni POU: tipo (FUNCTION, FUNCTION_BLOCK, PROGRAM, METHOD), nome, offset e lunghezza del codice, dimensione
del frame, dimensione dell'istanza (FB/PROGRAM), profondità massima della pila degli operandi, elenco delle
variabili (nome, sezione VAR_*, tipo, offset) per debug e per le chiamate con parametri per nome.

Formato 0.2 di ogni voce: `u8 tipo, u32 offset codice, u32 lunghezza codice, u32 dimensione frame,
u32 dimensione istanza, u8 n, {u8 kind, u32 offset nel frame}·n` (i parametri passati in pila, in ordine),
`u8 retKind, u32 retOff, str nome`. `retKind` è il kind del risultato elementare, 0 se non c'è, **11** se il
risultato è una STRING/STRUCT/ARRAY restituita per indirizzo (§6.2). Le POU che il programma non usa compaiono
con codice vuoto e frame 0 (gli indici delle POU restano stabili); con `--tutto` il compilatore le genera tutte.

### 6.1 Inizializzazione (`DATA`, `FRMI`)

L'immagine iniziale del segmento globale (`DATA`) contiene già tutti i valori iniziali, comprese le istanze di FB
e le capacità delle STRING. La sezione `FRMI` (`u32 n; {u16 pou, u32 lunghezza, byte}·n`) contiene per ogni POU
l'immagine iniziale del frame: valori iniziali di locali e `VAR_TEMP`, capacità delle STRING locali e dei
temporanei. A ogni chiamata la VM copia l'immagine nel nuovo frame (zeri se manca), poi scrive i parametri.

### 6.2 Passaggio dei parametri

| Parametro | Il chiamante mette in pila | La POU chiamata |
|---|---|---|
| VAR_INPUT elementare | il valore (il predefinito se manca) | lo trova nel frame |
| VAR_INPUT STRING/STRUCT/ARRAY | l'indirizzo del valore (0 se manca) | lo copia in una sua variabile nel prologo; con 0 tiene il valore iniziale |
| VAR_IN_OUT | l'indirizzo della variabile | vi accede per indirizzo |
| VAR_OUTPUT di FUNCTION | l'indirizzo della variabile di destinazione (0 se non collegata) | lavora su una copia locale e la scrive alla fine (epilogo), anche dopo `RETURN` |
| risultato STRING/STRUCT/ARRAY | — | `RET` mette in pila l'indirizzo del risultato nel frame appena liberato; il chiamante lo copia subito |

Per i FB, come prima: gli input si scrivono nell'istanza, i `VAR_IN_OUT` come indirizzi nell'istanza, poi
`ADDR` dell'istanza e `CALLFB`; le uscite `=>` si leggono dall'istanza dopo la chiamata. L'istanza può essere
calcolata (`cnt[i](...)`, array di FB).

### 6.3 Oggetti: METHOD, PROPERTY, EXTENDS (10/11/2026)

- **METHOD**: ogni metodo di un FB è una POU di tipo 4 (METHOD) di nome `FB.METODO`. Ha frame, parametri e
  risultato come una FUNCTION, e l'istanza del suo FB (base `I`). Il chiamante mette in pila l'indirizzo
  dell'istanza, poi gli argomenti come per una FUNCTION, poi `CALLM pou` oppure `CALLV`. I metodi stanno nel FB
  prima del corpo (grammatica di STruC++). Nelle POUS la dimensione dell'istanza di un METHOD è quella del suo FB (serve al debug).
- **PROPERTY**: due metodi, `FB.__GET_P` (risultato `P`) e `FB.__SET_P` (un `VAR_INPUT P`): si ridefiniscono
  come i metodi. Lettura `x.P`, `THIS.P` o `P` dentro il FB → GET; assegnamento → SET. Solo tipi elementari.
- **EXTENDS**: l'istanza del figlio ha prima tutte le variabili del padre, agli stessi offset, poi le sue (i metodi
  del padre lavorano anche sull'istanza del figlio). Chiamare il figlio esegue solo il suo corpo; `SUPER^()`
  esegue quello del padre (`ADDR I 0` + `CALLFB padre`), `SUPER^.M()` il metodo del padre senza scelta dinamica.
- **Tipo dell'istanza**: un FB con metodi, proprietà, `EXTENDS` o figli ha a offset 0 una `UDINT` nascosta
  `__TYPE` con l'indice della sua POU (scritta nella `DATA`/`FRMI` come valore iniziale, assente dai simboli).
- **Chiamata virtuale**: se un FB raggiungibile che discende dal tipo statico ridefinisce il metodo, il
  compilatore scrive `CALLV u8 nargs, u16 n, {u16 tipo, u16 pou}·n` con le coppie tipo → implementazione di
  tutti i tipi possibili; la VM legge `__TYPE` dall'istanza (sotto gli `nargs` argomenti) e sceglie. Altrimenti
  `CALLM`. Vale per `x.M()`, `THIS.M()`, `M()` dentro il FB e per le proprietà; così un metodo del padre che chiama
  un metodo ridefinito usa quello del figlio, anche con l'istanza passata come `VAR_IN_OUT` del tipo padre.
- **INTERFACE** (11/11/2026): una variabile di tipo interfaccia è un `LINT` con l'indirizzo dell'istanza; un FB (o un
  elemento di array di FB) dove si aspetta un'interfaccia mette il suo indirizzo, se la implementa. `I.M()` carica
  l'indirizzo e usa sempre `CALLV` con le coppie di tutti i FB raggiungibili che implementano l'interfaccia (anche
  tramite `EXTENDS` o interfacce che la estendono); i FB con `IMPLEMENTS` hanno `__TYPE`. Interfaccia nulla →
  trappola 4 alla lettura del tipo.
- **Risultati STRING/STRUCT/ARRAY** di METHOD e PROPERTY: come le FUNCTION (§6.2).
- **PROPERTY nelle interfacce, metodi e proprietà su un percorso** (11/11/2026): `I.P` usa `CALLV` sugli accessori
  `__GET_P`/`__SET_P` dei FB che implementano l'interfaccia; `A[i].M()`, `A[i].P`, `a.b.M()` (regola `pathCall` del
  parser, `MethodCallExpression`) mettono in pila l'indirizzo dell'elemento calcolato.
- **Non ancora**: `__NEW`/`__DELETE`, `VAR_INST`.

### 6.4 Sezioni facoltative per il debug (11/11/2026)

- `SYMT`: `u32 n; u32 indice·n`, i simboli della `DBUG` che sono BOOL (la VM li tiene come U8; il debug mostra
  TRUE/FALSE).
- `LOCS`: `u32 n; {u16 pou, u32 m, {str nome, u8 kind, u32 offset nel frame, u32 elementi, u8 flag}·m}·n`, le variabili
  del frame di ogni POU (parametri, locali, risultato elementare; flag bit 0 = BOOL): si leggono quando la POU è nella
  pila delle chiamate di un programma in pausa.
- Mappa righe: oltre all'inizio di ogni istruzione, una voce sull'`END_...` della POU (prima dell'epilogo), dove si
  ferma il passo passo dopo l'ultima istruzione o un `RETURN`.
- `LOCA` (11/11/2026): stesso formato dell'`IOMP`, l'indirizzo di **tutte** le variabili globali con indirizzo, anche
  quelle che il programma non usa (che non sono nell'`IOMP`): il debug può scriverle sulla macchina.
- `PROP` (11/11/2026): `u32 n; {str nome, u32 offset dell'istanza, u16 POU del GET, u8 tipo}·n`, le PROPERTY di ogni
  istanza (tipo = kind o 11 STRING; bit 0x80 = BOOL): il debug le legge eseguendo il GET sull'istanza.
- `STIM` (11/11/2026): `u32 n; u32 indice·n`, i simboli TIME/LTIME (ns; il debug li mostra come `T#…`). In `LOCS` il bit 1
  dei flag vale TIME, in `PROP` il bit 0x40 del tipo.
- `SREF` (11/11/2026): `u32 n; u32 indice·n`, i simboli che contengono un indirizzo (INTERFACE, POINTER, REF_TO; in `LOCS`
  bit 2 dei flag). `INST`: `u32 n; {str nome, u32 offset, u32 dimensione, u8 PROGRAM}·n`, le istanze di FB e PROGRAM: il
  debug mostra il nome a cui punta un indirizzo.
- Una VM che non le conosce le ignora.

## 7. Bytecode

Macchina a pila. Codice operativo da 1 byte, operandi immediati di lunghezza fissa per ogni codice (u8, u16, u32,
i32). Il tipo è parte del codice operativo (niente controllo dei tipi a run-time).

### 7.1 Famiglie di istruzioni

| Famiglia | Esempi | Note |
|---|---|---|
| Costanti | `PUSH_I32 imm`, `PUSH_I64 idx`, `PUSH_F64 idx`, `PUSH_ZERO` | costanti grandi da `CONS` |
| Caricamento | `LD_<t> base off` con `<t>` = `U8 I8 U16 I16 U32 I32 I64 F32 F64` | estende a 64 bit nello slot |
| Scrittura | `ST_<t> base off` | tronca alla dimensione |
| Indirizzi | `ADDR base off`, `INDEX elem_size type_idx` | `INDEX` controlla i limiti dell'array |
| Copia | `COPY size`, `STRCPY maxlen` | assegnamento di struct, array, stringhe |
| Aritmetica | `ADD_I32 ADD_I64 ADD_F32 ADD_F64`, `SUB`, `MUL`, `DIV`, `MOD`, `NEG`, `EXPT` | `DIV`/`MOD` intere: trappola su divisore 0 |
| Troncamento | `TRUNC_I8 TRUNC_U8 … TRUNC_U32` | riporta il risultato alla dimensione del tipo |
| Confronto | `EQ NE LT LE GT GE` per `I64 U64 F64` | risultato BOOL |
| Bit e logica | `AND OR XOR NOT`, `SHL SHR ROL ROR` per dimensione | |
| Conversioni | `I2F F2I_TRUNC F2I_ROUND F32_F64 F64_F32 …` | `REAL_TO_INT` arrotonda come la norma |
| Salti | `JMP rel32`, `JZ rel32`, `JNZ rel32` | |
| Chiamate | `CALL pou`, `CALLFB pou` (istanza in pila), `CALLM` / `CALLV` (metodo, §6.3), `RET` | |
| Native | `NATIVE idx` | §7.6 |
| Sistema | `NOP`, `BRK` (breakpoint, §10), `TRAP code` | |

Le espressioni di tipo più piccolo di 32 bit si calcolano a 32 o 64 bit e si troncano alla scrittura, come
prevede la promozione degli interi. La tabella sopra è il progetto; i codici effettivi della 0.2 sono in §7.7.

### 7.2 Chiamata di FUNCTION

Il chiamante mette in pila i parametri nell'ordine di dichiarazione (per posizione o per nome: il compilatore
li riordina; §6.2), esegue `CALL`. La VM crea il frame dall'immagine `FRMI`, vi scrive i parametri, e al `RET`
mette in pila il risultato (slot 0 del frame) o il suo indirizzo (`retKind` 11).

### 7.3 Chiamata di FUNCTION_BLOCK

Il compilatore scrive gli input direttamente nell'istanza, poi `ADDR` istanza e `CALLFB`; la VM crea il frame
del FB (per le `VAR_TEMP`); dopo la chiamata il compilatore legge gli output dall'istanza. `VAR_IN_OUT`: si
scrive l'indirizzo nell'istanza.

### 7.4 Controlli a run-time

- `INDEX`: indice fuori dai limiti dell'array → trappola.
- Accessi indiretti: segmento non valido o fuori limite → trappola.
- Divisione intera per zero → trappola. Divisione reale per zero → ±INF/NaN come IEEE (da allineare al C++).
- **Budget di istruzioni** per scansione (watchdog): superato il budget, il task si ferma con un errore. Il budget
  si ricava dal periodo del task.

### 7.5 Trappole

Una trappola ferma **solo quel task**, registra codice, POU, posizione nel codice e riga del sorgente, e SRV la
segnala (evento di errore verso l'HMI). Cosa fare delle uscite del task fermo è una decisione aperta (§12).

### 7.6 Funzioni native (chiamate verso SRV)

- Si dichiarano in ST come FUNCTION senza corpo ST, con il pragma esistente di STruC++:

  ```iecst
  FUNCTION AB_LanciaPP : DINT
    VAR_INPUT NomePP : STRING; END_VAR
    VAR_IN_OUT L : ARRAY[1..32] OF LREAL; END_VAR
    {external native AB_LanciaPP}
  END_FUNCTION
  ```

  Il nostro back-end riconosce `{external native <nome>}` e genera `NATIVE idx`; il back-end C++ incolla il
  pragma come testo, quindi per le prove di confronto si forniscono stub C++ con lo stesso nome. Nessuna modifica
  al front-end.
- La sezione `NATV` elenca nome e firma (tipi dei parametri). Al caricamento la VM collega ogni nome alla tabella
  delle funzioni host di SRV; nome mancante o firma diversa → il programma non si carica.
- Le native non possono bloccare la scansione: le operazioni lunghe (lancio di un `.pp`, movimenti) restituiscono
  un handle e lo stato si legge nelle scansioni successive (FB `MC_*` in tre tempi, analisi §8.3).
- Native fornite dalla VM stessa (non da SRV), come codici operativi: funzioni standard su stringhe (`STR`,
  §7.7) e matematiche (`MATH`). Da SRV serve solo `AB_TIME()`, il tempo all'inizio della scansione, uguale per
  tutta la scansione (usato dai timer); il compilatore la usa anche per la funzione CODESYS `TIME()`.
- Una FUNCTION dichiarata nei sorgenti ha sempre la precedenza su una standard con lo stesso nome (OSCAT
  definisce `CHR_TO_STRING`, `FLOOR`, `CEIL`…).

### 7.7 Codici operativi (formato 0.2)

Immediati little-endian. `kind` è il kind di §3.4 della VM (1 U8 … 10 F64), `base` è quella di §5.3.

| Codice | Nome | Immediati | Pila (prima → dopo) |
|---|---|---|---|
| 0x00 | NOP | | |
| 0x01 | PUSHI | i64 | → v |
| 0x02 | PUSHF | f64 | → v |
| 0x03 | POP | | v → |
| 0x04 | DUP | | v → v v |
| 0x05 | LD | u8 kind, u8 base, u32 off | (indirizzo se base P) → v |
| 0x06 | ST | u8 kind, u8 base, u32 off | (indirizzo se base P) v → |
| 0x07 | ADDR | u8 base, u32 off | → indirizzo |
| 0x08 | IDX | i32 lo, i32 hi, u32 passo | indirizzo, indice → indirizzo (trappola fuori limite) |
| 0x09 | COPY | u32 n | destinazione, sorgente → (memmove di n byte) |
| 0x0a | SWAP | | a b → b a |
| 0x10–0x18 | ADDI SUBI MULI DIVI DIVU MODI MODU NEGI ABSI | | interi a 64 bit; DIV/MOD per 0 → trappola |
| 0x19–0x1d | ADDF SUBF MULF DIVF NEGF | | reali in doppia precisione |
| 0x1e | F32R | | arrotonda a precisione singola |
| 0x1f | TRUNC | u8 kind | tronca l'intero alla dimensione del kind |
| 0x20–0x29 | EQI NEI LTI LEI GTI GEI LTU LEU GTU GEU | | a b → BOOL |
| 0x2a–0x2f | EQF NEF LTF LEF GTF GEF | | a b → BOOL |
| 0x30–0x34 | AND OR XOR NOTB NOTI | | |
| 0x35, 0x36, 0x46 | SHL SHR SAR | | v n → v (SAR: SHR dei tipi con segno) |
| 0x37–0x3c | MINI MAXI MINU MAXU MINF MAXF | | |
| 0x3d | SEL | | g in0 in1 → (g ? in1 : in0) |
| 0x3e, 0x3f | ROL ROR | u8 bit | v n → v ruotato su 8/16/32/64 bit |
| 0x40–0x43 | I2F U2F F2I F2IR | | F2I tronca, F2IR arrotonda lontano da zero |
| 0x44 | MATH | u8 funzione | 1 SQRT 2 LN 3 LOG 4 EXP 5 SIN 6 COS 7 TAN 8 ASIN 9 ACOS 10 ATAN 11 POW 12 ABS 13 FLOOR 14 ATAN2 |
| 0x45 | STR | u8 funzione | funzioni stringa, tabella sotto |
| 0x50–0x52 | JMP JZ JNZ | i32 relativo all'istruzione seguente | |
| 0x60 | CALL | u16 pou | parametri → (risultato) |
| 0x61 | CALLFB | u16 pou | indirizzo istanza → |
| 0x62 | RET | | |
| 0x63 | NATIVE | u16 indice NATV | parametri → (risultato) |
| 0x64 | CALLM | u16 pou | indirizzo istanza, parametri → (risultato) |
| 0x65 | CALLV | u8 nargs, u16 n, {u16 tipo, u16 pou}·n | come CALLM; la POU dal `__TYPE` dell'istanza (trappola 1 se manca) |
| 0x70, 0x71 | BRK TRAP | —, u8 codice | |

Funzioni `STR` (gli operandi STRING sono indirizzi del primo carattere; `d` è la destinazione, il risultato è
troncato alla sua capacità; posizioni da 1 come IEC, interpretate senza segno come il C++):

| n | Funzione | Pila | Note |
|---|---|---|---|
| 1 | ASSIGN | d s → | anche con d e s sovrapposte |
| 2 | CONCAT | d a b → | `CONCAT(a, b, c…)` si genera a coppie |
| 3 | LEN | a → n | |
| 4, 5 | LEFT, RIGHT | d a n → | |
| 6 | MID | d a L P → | P = 0 → vuota |
| 7 | INSERT | d a b P → | b **dopo** il P-esimo carattere (IEC: `INSERT('ABC','XY',2)` = `'ABXYC'`) |
| 8 | DELETE | d a L P → | |
| 9 | REPLACE | d a b L P → | |
| 10 | FIND | a b → posizione | 0 se assente o b vuota |
| 11 | CMP | a b → −1/0/1 | per `= <> < <= > >=` tra STRING |
| 12–15 | FROM_INT, FROM_UINT, FROM_REAL, FROM_LREAL | d v → | `%lld`, `%llu`, `%g` come `TO_STRING` di STruC++ |
| 16, 17 | TO_INT, TO_REAL | a → v | `strtoll`/`strtod` |
| 18, 19 | FROM_BOOL, FROM_TIME | d v → | `TRUE`/`FALSE`; TIME in ns come numero (da rivedere) |
| 20 | CHR | d codice → | stringa di un carattere |
| 21 | CODE | a P → codice | 0 fuori limite |

## 8. Task (`TASK`)

- Da `CONFIGURATION / RESOURCE / TASK`: nome, `INTERVAL` (ns), `PRIORITY` (ordina i task dentro `ThreadTaskST`),
  programmi associati in ordine.
- Il periodo è arrotondato al multiplo del ciclo del driver; la VM lo segnala se l'arrotondamento cambia il valore.
- Senza CONFIGURATION: un task predefinito con tutti i PROGRAM. **Periodo predefinito da decidere** (§12).
- Task a evento (`SINGLE`): fase successiva.

## 9. Variabili con indirizzo (`IOMP`)

Per ogni variabile `AT %…`: area (I, Q, M), dimensione (X, B, W, D, L), indirizzo (byte, bit), offset nel segmento
globale, tipo.

- La VM, non il codice, copia le aree: a inizio scansione ingressi `%I` e merker `%M` letti; a fine scansione
  uscite `%Q` e merker `%M` scritti **solo se cambiati** (analisi §12.2).
- Corrispondenza con AxesBrain: ingresso/uscita digitale n ↔ `%IX/%QX((n-1)/8).((n-1)%8)`; analogici
  `%IW/%QW n`; merker = I/O virtuali del driver (uscite digitali `Mw.b`): `%MX(2(w-1)+(b-1)/8).((b-1)%8)`, e
  `%MW(w-1)` = la word dei 16 merker `Mw.1 … Mw.16` (bit 0 = `Mw.1`), che la VM compone dai bit in lettura e scompone
  in scrittura: non ha un'immagine sua (11/11/2026).
- I nomi simbolici (`OUT42`, `M1.10`) non sono nel `.stc`: li porta il file di variabili globali generato dall'HMI
  dalla configurazione degli I/O.

## 10. Debug (`DBUG`)

- **Simboli**: nome gerarchico (`Main.Ciclo.Pezzi`, `Main.T1.Q`), tipo, segmento, offset. Bastano per lettura e
  forzatura per nome. Formato 0.2: `str nome, u8 kind, u32 offset, u32 conteggio`; `kind` 11 = STRING (offset
  del primo carattere, capacità nei 4 byte prima); un array di elementari o di STRING è un solo simbolo col
  conteggio degli elementi (per righe); gli array di STRUCT o di FB si espandono per elemento (`Main.M[1,2].X`).
  I `VAR_IN_OUT` (indirizzi) non sono simboli.
- **Mappa righe**: per ogni POU, coppie (offset nel codice → file, riga, colonna) all'inizio di ogni istruzione ST. L'offset (`pc`) è
  relativo all'inizio del codice della POU (`codeOff` della sezione POUS), non al blocco CODE intero.
- **Breakpoint**: la VM sostituisce il primo codice operativo della riga con `BRK` e conserva l'originale. Al
  `BRK` il task si sospende a fine istruzione corrente; con un PLC a scansione le uscite restano congelate (decisione
  aperta, analisi §4 punto 7).
- **Forzature**: tabella (indirizzo, valore) applicata dopo la lettura degli ingressi e prima della scrittura delle
  uscite. Le scritture da HMI o COM vanno in coda e si applicano a inizio scansione.
- **Prove di confronto**: lo stesso programma compilato in C++ (back-end originale) e in `.stc`, eseguito N cicli
  con gli stessi ingressi; si confrontano tutte le variabili a ogni ciclo. Corpus: test ed esempi di STruC++,
  OSCAT BASIC, programmi nostri.

## 11. Libreria standard AxesBrain

Scritta da noi in ST, compilata come FB normali (analisi §11.3 punto 4): `TON`, `TOF`, `TP`, `CTU`, `CTD`, `CTUD`,
`R_TRIG`, `F_TRIG`, `SR`, `RS`. I timer usano `AB_TIME()`. Poi i FB `MC_*` che lanciano i `.pp`, e i servizi
(`AB_Display`, `AB_SetEvento`, `AB_GetG`/`AB_SetG`).

### 11.1 Native di AxesBrainSRV (09/11/2026)

- Globali G (`ablib.st`): `AB_GETG`, `AB_SETG`, `AB_GETG_N`, `AB_SETG_N` (le varianti `_N` ricevono `ADR(array di
  LREAL)`; la VM espone `NativePointer()`). Lettura e scrittura al momento della chiamata.
- Lancio di `.pp` (`ablib_pp.st`): `AB_PP_NUOVO`, `AB_PP_SETL`, `AB_PP_AVVIA`, `AB_PP_STATO`, `AB_PP_GETL`,
  `AB_PP_RILASCIA`, usate da `AB_RunPP` e dai blocchi `MC_*`. La STRING del nome arriva come indirizzo e la nativa la
  legge con `NativeString()`. Dal 10/11/2026 `AB_RunPP` ha 16 ingressi (L1…L16) e 8 uscite (R1…R8 = L21…L28).

## 12. Decisioni aperte

1. Periodo del task predefinito quando manca la CONFIGURATION: **10 ms** (confermato da Andrea, 09/11/2026).
2. Uscite di un task fermato da una trappola, da un arresto o da un reset: **a 0** (come OpenPLC e l'opzione
   "valori di default" di CODESYS), applicato in AxesBrainSRV; i merker restano come sono. Con un breakpoint:
   congelate (da fare).
3. Semantica dell'overflow intero e della divisione reale per zero: fissata con le prove di confronto (§4). Dove
   il C++ di STruC++ si scosta dalla norma o da CODESYS, la VM segue la norma/CODESYS (**confermato da Andrea,
   09/11/2026**, tutte e sei):
   - `VAR_TEMP` dei FB reinizializzate a ogni chiamata (il C++ le tiene persistenti come membri);
   - `INSERT(IN1, IN2, P)` inserisce dopo il P-esimo carattere (il C++ prima);
   - `CONCAT` non tronca il risultato alla capacità degli argomenti (il C++ sì: `CONCAT` di due STRING(5) dà
     5 caratteri);
   - aritmetica dei puntatori in byte (il C++ in elementi del suo tipo involucro);
   - `SIZEOF` di un puntatore vale 4 come in CODESYS a 32 bit, perché OSCAT lo usa come passo degli array di
     REAL (`ARRAY_MAX`, `ARRAY_MIN`, `ARRAY_SUM`, `ARRAY_SPR`, `_ARRAY_SORT`, `_ARRAY_MEDIAN`);
   - `NOT` di un'espressione BOOL è sempre logico (il C++ genera in qualche caso un NOT bit a bit e `GCD` di
     OSCAT non termina).
4. **Lancio del PLC ST** (deciso il 09/11/2026, dettagli nell'analisi di AxesBrainSRV §13): sotto-sistema COM
   numero 6 in `ExecSubSystemProcess` / `KillSubSystemProcess` e negli altri metodi che usano il numero; avvio
   automatico con `NomePartProgramLancioST` sotto `[ParametriAUTOMAZIONE]`, dopo `Main.pp`. Si lanciano sia `.st`
   sia `.stc` dalla cartella `partprogST` (valore di registro `PathPartProgramST`): con `.st` la VM confronta l'MD5
   del sorgente con quello nell'intestazione del `.stc` (§3), e dal 10/11/2026 anche quello dei file della sezione
   `SRCS` che esistono ancora, e segnala se va ricompilato. Il PLC lanciato da
   `sistema.txt` non è resettabile; quello lanciato da COM sì, salvo un bit di `iMaskMode`. Lancio da un `.pp`: si
   decide più avanti.
5. **Merker** (deciso il 09/11/2026): `%MX` sulle uscite virtuali `Mw.b`, regola lineare che parte da M1.1:
   `%MX0.0` = `M1.1` … `%MX0.7` = `M1.8`, `%MX1.0` = `M1.9` … `%MX1.7` = `M1.16`, `%MX2.0` = `M2.1` (il front-end
   accetta solo bit 0…7, come la norma).
6. Ricarica del programma a macchina accesa: fase successiva (seconda istanza della VM, scambio a fine scansione,
   trasferimento dei valori per nome e tipo).

### 12.9 Eseguibile unico (11/11/2026)

`npm run build:stc-exe` (`scripts/build-stc-exe.mjs`): bundle esbuild di `cli-stc` + Single Executable Application di
Node.js con il `node.exe` locale e `postject`. In `dist/stc`: `axesbrain-stc.exe`, `libs/*.st`, licenze e `LEGGIMI.txt`. Stessa
riga di comando di `node dist/backend-stc/cli-stc.js`, stessi `.stc`.

## 13. Stato del prototipo (09/11/2026)

Prototipo 0.2 (formato `.stc` 0.2), fuori da AxesBrainSRV.

- **Back-end** in questo repository: `src/backend-stc/` (`stc-format.ts` codici e costanti, `stc-codegen.ts`
  generatore, `stc-writer.ts` contenitore binario, `cli-stc.ts` riga di comando):

  ```
  node dist/backend-stc/cli-stc.js programma.st libs/axesbrain/ablib.st -o programma.stc [--json diagnostica.json]
       [--lib libs/oscat-basic.stlib] [-D NOME=valore] [--tutto]
  ```

  `--lib` aggiunge i sorgenti ST e le costanti di un archivio `.stlib` (OSCAT); `--tutto` genera il codice di
  tutte le POU, non solo di quelle usate dai programmi. Gli errori del generatore sono raccolti POU per POU.
- **Libreria standard** `libs/axesbrain/ablib.st`, scritta da zero, licenza MIT: `R_TRIG`, `F_TRIG`, `SR`, `RS`,
  `CTU`, `CTD`, `CTUD`, `TON`, `TOF`, `TP`, con `AB_TIME()` nativa. Va compilata insieme a OSCAT al posto
  di `iec-standard-fb`.
- **Supportato** (oltre a quanto c'era nella 0.1: elementari, FUNCTION/FB/PROGRAM, globali, task, I/O, controlli,
  conversioni, matematiche, native, trappole, debug):
  - `VAR_TEMP` (FUNCTION, FB, PROGRAM) reinizializzate a ogni chiamata; locali delle FUNCTION con valore iniziale
    di qualunque tipo (immagine `FRMI`);
  - `STRING` e `STRING(n)` (anche con costante per la lunghezza), letterali con `$`, assegnamento con
    troncamento, confronti `= <> < <= > >=`, `LEN LEFT RIGHT MID CONCAT` (anche con più argomenti) `INSERT DELETE
    REPLACE FIND`, `*_TO_STRING` e `STRING_TO_*` numerici, `CHR`; STRING come parametri, risultati, campi,
    elementi di array, `VAR_IN_OUT` di qualunque lunghezza;
  - `TYPE`: `STRUCT` (annidate, con array e STRING, valori iniziali dei campi), enum (anche con valori espliciti,
    tipo base, `Tipo#Valore`, in `CASE`), array con nome, sottointervalli, alias;
  - array a più dimensioni e array di array, di STRUCT, di STRING, di FB (`cnt[i](...)`);
  - `VAR_IN_OUT` di FUNCTION e FB, `VAR_OUTPUT` delle FUNCTION (`F(x, Q => q)`), risultato STRUCT/ARRAY/STRING;
  - `POINTER TO`, `REF_TO`, `REFERENCE TO`, `ADR`, `REF`, `^`, `NULL`, aritmetica dei puntatori in byte,
    `SIZEOF`, `LOWER_BOUND`/`UPPER_BOUND`, accesso ai bit `x.3` in lettura e scrittura;
  - inizializzatori di array (con ripetizioni `3(0)`) e di STRUCT/FB (`(y := 7)`), costanti calcolate, costanti
    globali (`VAR_GLOBAL CONSTANT`, `-D`), DATE/TOD/DT e conversioni temporali come CODESYS, `TIME()`;
  - `ROL ROR MUX ODD`, gli operatori scritti come funzioni (`NOT(x)`, `ADD(a, b, c)`, `GT(a, b)`...).
- **OSCAT BASIC 3.35**: con `--lib libs/oscat-basic.stlib --tutto` si compilano **tutte** le 557 POU (560 file,
  compreso `GVL_0`) in un `.stc` di circa 310 KB che la VM carica. Unica nativa richiesta: `AB_TIME`. Provate a
  run-time (§10, `tests-stc/confronto/osc1.st` e `osc2.st`): circa 45 funzioni e FB di matematica, array,
  stringhe, date, bit, numeri complessi, regolazione e temporizzazione.
- **Non ancora**: `WSTRING`, `ARRAY[*]`, interfacce (metodi, proprietà ed `EXTENDS` dal 10/11/2026, §6.3), `VAR_INST`, `__NEW`/
  `__DELETE`, `RETAIN`, task a evento, `TIME_TO_STRING` e `DT_TO_STRING` nel formato IEC (ora numerici), STRING
  passate alle native di SRV, breakpoint e forzature (i dati per farli ci sono).
- **Prove di confronto col back-end C++** (`tests-stc/confronto.mjs`, g++ 13.2 di WSL): stesso sorgente compilato
  nei due modi, tutte le variabili confrontate a ogni ciclo.

  | Caso | Contenuto | Esito |
  |---|---|---|
  | `sem1` | overflow di tutti i tipi interi, misti con e senza segno, REAL/LREAL, divisione reale per 0, conversioni implicite ed esplicite, SHL/SHR/ROL/ROR, MUX/SEL/LIMIT, TIME, FOR | uguale (96 variabili × 12 cicli; 1 LREAL diverso nell'ultima cifra: `ATAN`/`TAN` di glibc e di MSVC) |
  | `str1` | STRING e funzioni stringa | uguale, salvo le scelte di §12.3 (`INSERT`, `CONCAT`) |
  | `agg1` | STRUCT, enum, array 2D/3D, uscite di FUNCTION, VAR_IN_OUT, ritorno STRUCT, array di FB | uguale, salvo `VAR_TEMP` dei FB (§12.3) |
  | `pun1` | puntatori, REF_TO, bit | uguale, salvo l'aritmetica dei puntatori (§12.3) |
  | `osc1` | OSCAT: matematica, date, bit, complessi, `CTRL_PI`, `CLK_DIV`, `FIFO_16`, `HYST`, `TP_X`, `FT_PT1` | uguale (152 variabili × 12 cicli) |

  Le funzioni OSCAT che scrivono tramite puntatori (`osc2`: `ARRAY_AVG`, `ARRAY_MAX`, `_ARRAY_SORT`,
  `DWORD_TO_STRH`, `FILL`, `REAL_TO_STRF`, `GCD`) **non** sono confrontabili: nel C++ di STruC++ danno valori
  senza senso o non terminano. Lì i valori della VM sono stati controllati a mano e fissati come regressione.
  Il C++ di STruC++ non compila inoltre `CONCAT` a più di due argomenti di tipo misto, `>=` tra STRING, un
  `VAR_IN_OUT` STRING legato a una STRING(n), un parametro `POINTER TO BYTE`, e con la libreria OSCAT da
  `.stlib` chiede come parametri le variabili locali delle funzioni: le prove aggirano questi limiti.
- **Prove di regressione** (`STVM=...stvm-test.exe node tests-stc/esegui.mjs`, senza WSL): 15 casi, compresi i
  casi di confronto con le uscite già validate e le trappole (indice fuori limite in un array 2D di STRUCT,
  puntatore nullo).
- **Prestazioni** con la VM di prova (MSVC x64, `/O2`, misurate con g++ in esecuzione in parallelo): circa 4–5 ns
  per istruzione. `bench1` (~3.700 istruzioni) 14–15 µs per scansione (21 µs nella 0.1), `prove1` 2,1 µs, timer di
  `lib1` 0,55 µs, `agg1` 3,4 µs, `osc1` (~1.950 istruzioni, 6 FB OSCAT e ~25 funzioni) 7,5 µs, `osc2` (stringhe e
  ordinamento OSCAT, ~4.900 istruzioni) 22–26 µs.
