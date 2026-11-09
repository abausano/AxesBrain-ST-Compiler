(* Confronto C++ / .stc: un campione di OSCAT BASIC senza puntatori (matematica, date,
   bit, numeri complessi, FB di controllo e temporizzati). *)

PROGRAM Osc
  VAR
    c : INT;
    f1 : DINT; g1 : INT; h1 : REAL; ce : INT; fr : REAL; fl : INT;
    arr : ARRAY[1..8] OF REAL := [5.0, 3.0, 9.0, 1.0, 7.0, 2.0, 8.0, 4.0];
    ok : BOOL; avg : REAL; mx : REAL;
    s1 : STRING; s2 : STRING; s3 : STRING; s4 : STRING; s5 : STRING;
    s6 : STRING; s7 : STRING; s8 : STRING; s9 : STRING;
    di : INT; nc : INT; fc : INT;
    dw : INT; ly : BOOL; dm : INT; d1 : DATE; d2 : DATE; d3 : DATE;
    dy : INT; mo : INT; yr : INT;
    bc : INT; rv : BYTE; gr : BYTE; bcd : BYTE;
    z1 : COMPLEX; z2 : COMPLEX; cr : REAL; ca : REAL;
    pi1 : CTRL_PI; cd : CLK_DIV; ff : FIFO_16; hy : HYST; tpx : TP_X; pt1 : FT_PT1;
    dt1 : DT;
  END_VAR

  c := c + 1;
  (* matematica *)
  f1 := FACT(c MOD 10);
  h1 := HYPOT(3.0, INT_TO_REAL(c));
  ce := CEIL(INT_TO_REAL(c) / 3.0);
  fr := FRACT(INT_TO_REAL(c) * 1.25);
  fl := FLOOR(-INT_TO_REAL(c) / 4.0);
  (* date *)
  d1 := SET_DATE(2024, 2, c);
  dw := DAY_OF_WEEK(d1);
  ly := LEAP_YEAR(2000 + c);
  dm := DAYS_IN_MONTH(d1);
  d2 := DATE_ADD(d1, c, 0, 1, 0);
  d3 := EASTER(2020 + c);
  dy := DAY_OF_YEAR(d2);
  mo := MONTH_OF_DATE(d3);
  yr := YEAR_OF_DATE(d3);
  dt1 := SET_DT(2024, 3, 4, 5, c, 7);
  (* bit *)
  bc := BIT_COUNT(DINT_TO_DWORD(c * 1001));
  rv := REVERSE(INT_TO_BYTE(c));
  gr := BYTE_TO_GRAY(INT_TO_BYTE(c * 3));
  bcd := INT_TO_BCDC(c * 7);
  (* complessi *)
  z1.re := INT_TO_REAL(c);
  z1.im := 2.0;
  z2.re := 1.5;
  z2.im := -1.0;
  cr := CABS(z1);                    (* z3 := CMUL(z1, z2): il front-end C++ con la libreria rifiuta COMPLEX := COMPLEX *)
  ca := CARG(z2);
  (* FB *)
  pi1(ACT := INT_TO_REAL(c), SET := 10.0, KP := 0.5, KI := 0.1);
  cd(clk := c MOD 2 = 0);
  ff(Din := INT_TO_DWORD(c * 3), E := TRUE, WD := c MOD 3 = 0, RD := c MOD 4 = 0);
  hy(In := INT_TO_REAL(c MOD 7), ON := 4.0, OFF := 2.0);
  tpx(IN := c MOD 6 = 1, PT := T#30ms);
  pt1(in := 100.0, T := T#50ms);
END_PROGRAM
