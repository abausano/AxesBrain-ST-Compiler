(* Confronto C++ / .stc: semantica di interi, reali, conversioni e cicli. *)

FUNCTION Doppio : INT
  VAR_INPUT X : INT; END_VAR
  Doppio := X * 2;
END_FUNCTION

PROGRAM Sem
  VAR
    c : DINT;
    si : SINT := 120;
    usi : USINT := 250;
    i : INT := 32760;
    ui : UINT := 65530;
    di : DINT := 2147483600;
    udi : UDINT := 4294967290;
    li : LINT := 9223372036854775800;
    uli : ULINT := 18446744073709551610;
    b : BYTE := 16#F0;
    w : WORD := 16#FFF0;
    dw : DWORD := 16#FFFFFFF0;
    mix1 : INT; mix2 : DINT; mix3 : UINT; mix4 : LINT;
    dv1 : INT; dv2 : INT; md1 : INT; md2 : INT; md3 : DINT;
    r : REAL := 0.1;
    r2 : REAL; r3 : REAL; r4 : REAL;
    lr : LREAL := 0.1;
    lr2 : LREAL; lr3 : LREAL;
    rz1 : REAL; rz2 : LREAL; rz3 : REAL;
    cv1 : INT; cv2 : INT; cv3 : DINT; cv4 : UINT; cv5 : SINT; cv6 : REAL; cv7 : LREAL; cv8 : DINT; cv9 : BYTE;
    cv10 : INT; cv11 : DINT; cv12 : LINT;
    cmp1 : BOOL; cmp2 : BOOL; cmp3 : BOOL; cmp4 : BOOL;
    sh1 : BYTE; sh2 : WORD; sh3 : DWORD; sh4 : INT; sh5 : BYTE;
    nb : BYTE; nw : WORD;
    k : INT; somma : DINT; fine : INT; passo : INT; giri : INT; kfin : INT;
    n : INT; m : INT;
    ex1 : REAL; ex2 : LREAL;
    neg1 : INT; neg2 : SINT;
    t1 : TIME := T#1s; t2 : TIME;
    sh6 : WORD; sh7 : INT; sh8 : DWORD;
    im1 : INT; im2 : DINT; im3 : BYTE; im4 : REAL; im5 : LREAL; im6 : BOOL; im7 : UINT;
    m1 : REAL; m2 : LREAL; m3 : REAL; m4 : LREAL; m5 : REAL; m6 : LREAL; m7 : REAL;
    q1 : BOOL; q2 : BOOL; q3 : BOOL; q4 : DINT; q5 : LINT; q6 : INT;
    tm1 : DINT; tm2 : TIME; tm3 : REAL; tm4 : TIME; tm5 : LREAL;
  END_VAR

  c := c + 1;
  (* overflow per tipo *)
  si := si + 3;
  usi := usi + 3;
  i := i + 3;
  ui := ui + 3;
  di := di + 30;
  udi := udi + 3;
  li := li + 3;
  uli := uli + 3;
  b := b + 16#11;
  w := w + 16#11;
  dw := dw + 16#11;

  (* espressioni miste *)
  mix1 := i * 2 + 1;
  mix2 := i * 1000;
  mix3 := ui - 65535;
  mix4 := di * 3;
  dv1 := -7 / 2;
  dv2 := i / 7;
  md1 := -7 MOD 3;
  md2 := 7 MOD -3;
  md3 := di MOD 1000;

  (* reali *)
  r := r * 1.1 + 0.3;
  r2 := r / 3.0;
  r3 := r * r - 0.5;
  r4 := INT_TO_REAL(i) / 3.0;
  lr := lr * 1.1 + 0.3;
  lr2 := lr / 3.0;
  lr3 := lr * r;
  rz1 := 1.0 / 0.0;
  rz2 := -1.0 / 0.0;
  rz3 := r2 / 0.0;
  ex1 := r ** 2.0;
  ex2 := EXPT(lr, 3.0);

  (* conversioni *)
  cv1 := REAL_TO_INT(2.5);
  cv2 := REAL_TO_INT(-3.5);
  cv3 := LREAL_TO_DINT(lr * 1000.0);
  cv4 := INT_TO_UINT(-5);
  cv5 := INT_TO_SINT(300);
  cv6 := LREAL_TO_REAL(lr);
  cv7 := REAL_TO_LREAL(r);
  cv8 := TRUNC(r * 100.0);
  cv9 := WORD_TO_BYTE(w);
  cv10 := DINT_TO_INT(di);
  cv11 := REAL_TO_DINT(r * 7.0);
  cv12 := TIME_TO_LINT(t1);

  (* confronti *)
  cmp1 := ui > 100;
  cmp2 := i < -5;
  cmp3 := r > 0.5;
  cmp4 := udi < 10;

  (* bit *)
  sh1 := SHL(b, 3);
  sh2 := SHR(w, 4);
  sh3 := SHL(dw, 8);
  sh4 := SHR(i, 2);
  sh5 := ROL(b, 3);
  sh6 := ROR(w, 4);
  sh7 := SHR(neg1, 2);
  sh8 := ROL(dw, 36);
  nb := NOT b;
  nw := NOT w;

  (* FOR: limite rivalutato, passo variabile, variabile dopo il ciclo *)
  somma := 0;
  fine := 5;
  giri := 0;
  FOR k := 1 TO fine DO
    somma := somma + k;
    IF k = 2 THEN fine := 3; END_IF
    giri := giri + 1;
  END_FOR
  kfin := k;
  passo := 2;
  FOR k := 0 TO 9 BY passo DO somma := somma + k * 100; END_FOR
  passo := -2;
  FOR k := 9 TO 0 BY passo DO somma := somma + k * 10000; END_FOR

  n := Doppio(i);
  m := Doppio(X := 20000);
  neg1 := -i;
  neg2 := -si;
  t2 := t2 + T#10ms;

  (* conversioni implicite *)
  im1 := r * 10.0;
  im2 := lr * 100.0;
  im3 := i;
  im4 := i;
  im5 := di;
  im6 := i > 0 AND r < 100.0;
  im7 := -1;

  (* funzioni matematiche *)
  m1 := SQRT(r);
  m2 := SQRT(lr);
  m3 := SIN(r) + COS(r);
  m4 := LN(lr) * EXP(lr / 10.0);
  m5 := ABS(r - 10.0);
  m6 := ATAN(lr) + TAN(lr / 100.0);
  m7 := MAX(r, 2.5, r * 0.5);

  (* misti con segno *)
  q1 := di < udi;
  q2 := si > usi;
  q3 := NOT (i = 0) XOR cmp1;
  q4 := SEL(cmp2, 10, 20) + LIMIT(-5, i, 5) + MIN(i, 3);
  q5 := li / 1000000 - uli / 1000000000;
  q6 := MUX(c MOD 3, 11, 22, 33);

  (* tempo *)
  tm1 := TIME_TO_DINT(t2);
  tm2 := DINT_TO_TIME(c * 250);
  tm3 := TIME_TO_REAL(t2) / 3.0;
  tm4 := t2 * 3 - T#5ms;
  tm5 := LREAL_TO_REAL(lr) * 2.0;
END_PROGRAM
