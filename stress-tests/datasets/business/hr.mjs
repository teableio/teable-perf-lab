// HR business profile: Departments -> Employees -> LeaveRequests / Reviews / Payroll.
// Every value is synthetic: names/emails use employee<number>@example.test and there are no
// phone numbers, national IDs or bank accounts. All references derive from record indexes,
// so the dataset is deterministic and never produces dangling links.

const DEPARTMENT_NAMES = [
  'Engineering',
  'Product',
  'Design',
  'Data & Analytics',
  'Sales',
  'Marketing',
  'Customer Success',
  'People Operations',
  'Finance',
  'Legal',
  'Operations',
  'Quality Assurance',
];

const LOCATIONS = ['Beijing', 'Shanghai', 'Shenzhen', 'Singapore', 'Remote'];

const TITLES = [
  'Engineer',
  'Senior Engineer',
  'Staff Engineer',
  'Engineering Manager',
  'Product Manager',
  'Designer',
  'Data Analyst',
  'Account Executive',
  'Sales Manager',
  'Marketing Specialist',
  'Customer Success Manager',
  'HR Specialist',
  'Recruiter',
  'Finance Analyst',
  'Operations Specialist',
  'Legal Counsel',
];

const EMPLOYMENT_TYPES = ['Full-time', 'Full-time', 'Full-time', 'Full-time', 'Contract', 'Part-time'];
const EMPLOYEE_STATUSES = [
  'Active', 'Active', 'Active', 'Active', 'Active', 'Active', 'Active', 'Active',
  'Probation', 'OnLeave', 'Terminated',
];
const LEVELS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'];
const SKILLS = [
  'SQL', 'Excel', 'Communication', 'Project Management',
  'Python', 'Negotiation', 'Data Modeling', 'Public Speaking',
];

const LEAVE_TYPES = ['Annual', 'Sick', 'Personal', 'Parental', 'Unpaid'];
const LEAVE_TYPE_WEIGHTS = [4, 3, 2, 1, 1];
const LEAVE_STATUSES = ['Approved', 'Pending', 'Rejected', 'Cancelled'];
const LEAVE_STATUS_WEIGHTS = [5, 2, 1, 1];

const REVIEW_STATUSES = ['Submitted', 'Acknowledged', 'Draft'];
const REVIEW_STATUS_WEIGHTS = [3, 4, 1];
const REVIEW_PERIODS = ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4'];

const PAYROLL_STATUSES = ['Paid', 'Pending', 'Failed'];
const PAYROLL_STATUS_WEIGHTS = [8, 1, 1];

function weighted(random, values, weights) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = random() * total;
  for (let i = 0; i < values.length; i++) {
    roll -= weights[i];
    if (roll < 0) return values[i];
  }
  return values[values.length - 1];
}

function pad(value, width) {
  return String(value).padStart(width, '0');
}

export default function createProfile(options, helpers) {
  const {
    count, rng, pick, money, date, note,
    text, number, dateField, select, multiSelect, checkbox, linkField, formula,
  } = helpers;

  // Only the department count scales: employee, leave, review and payroll rows follow from it.
  const departmentsCount = count('departments', 10, { scaled: true });
  const employeesPerDepartment = count('employees-per-department', 30);
  const leavePerEmployee = count('leave-requests-per-employee', 2, { min: 0 });
  const reviewsPerEmployee = count('reviews-per-employee', 2, { min: 0 });
  const payrollPeriods = count('payroll-periods', 3, { min: 0 });

  const employeesCount = departmentsCount * employeesPerDepartment;
  const leaveCount = employeesCount * leavePerEmployee;
  const reviewCount = employeesCount * reviewsPerEmployee;
  const payrollCount = employeesCount * payrollPeriods;

  const leaveGroupSize = Math.max(1, leavePerEmployee);
  const reviewGroupSize = Math.max(1, reviewsPerEmployee);
  const payrollGroupSize = Math.max(1, payrollPeriods);

  function noteRng(index, salt) {
    return rng(index, salt);
  }

  function departmentIndex(employeeIndex) {
    return Math.floor(employeeIndex / employeesPerDepartment);
  }

  function departmentName(index) {
    const base = DEPARTMENT_NAMES[index % DEPARTMENT_NAMES.length];
    const cycle = Math.floor(index / DEPARTMENT_NAMES.length);
    return cycle === 0 ? base : `${base} ${cycle + 1}`;
  }

  // Hire dates sit before the earliest payroll period (at least 90 days before the
  // 2026-10-01 anchor), so employment always starts before leave, reviews and payroll.
  const earliestPayrollLookback = Math.max(90, payrollPeriods * 30 + 30);
  function hireOffset(employeeIndex) {
    const random = rng(employeeIndex, 11);
    return -(earliestPayrollLookback + Math.floor(random() * 2400));
  }

  function annualLeaveEntitlement(employeeIndex) {
    const random = rng(employeeIndex, 12);
    return 18 + Math.floor(random() * 8);
  }

  function employeeLevel(employeeIndex) {
    const random = rng(employeeIndex, 14);
    return 1 + Math.floor(random() * LEVELS.length);
  }

  function monthlyBase(employeeIndex) {
    const random = rng(employeeIndex, 13);
    return money(8000 + employeeLevel(employeeIndex) * 5200 + random() * 9000);
  }

  // Annual leave consumes the balance; other leave types snapshot the balance unchanged.
  function buildLeavePlan(employeeIndex, slot, available) {
    const random = rng(employeeIndex, 100 + slot);
    const startWindow = -240 + Math.floor(random() * 420);
    const startDay = Math.max(hireOffset(employeeIndex) + 30, startWindow);
    let days = 1 + Math.floor(random() * 7);
    let type = weighted(random, LEAVE_TYPES, LEAVE_TYPE_WEIGHTS);
    if (type === 'Annual') {
      if (available <= 0) {
        type = 'Unpaid';
      } else {
        days = Math.min(days, available);
      }
    }
    const status = weighted(random, LEAVE_STATUSES, LEAVE_STATUS_WEIGHTS);
    const balanceAfter = type === 'Annual' && status === 'Approved' ? available - days : available;
    return {
      type,
      startDay,
      endDay: startDay + days - 1,
      days,
      status,
      balanceBefore: available,
      balanceAfter,
    };
  }

  function availableLeave(employeeIndex, slot) {
    const entitlement = annualLeaveEntitlement(employeeIndex);
    let used = 0;
    for (let previous = 0; previous < slot; previous++) {
      const plan = buildLeavePlan(employeeIndex, previous, entitlement - used);
      if (plan.type === 'Annual' && plan.status === 'Approved') used += plan.days;
    }
    return entitlement - used;
  }

  function reviewDay(employeeIndex, slot) {
    const random = rng(employeeIndex, 200 + slot);
    const dayWindow = -200 + Math.floor(random() * 185);
    return Math.max(hireOffset(employeeIndex) + 20, dayWindow);
  }

  function reviewPeriod(day) {
    const parsed = new Date(date(day));
    const quarter = Math.floor(parsed.getUTCMonth() / 3) + 1;
    return `${parsed.getUTCFullYear()}-Q${quarter}`;
  }

  // Reviewer stays inside the employee's department and is never the reviewee.
  // When a department has exactly one employee there is no in-department peer,
  // so that sole employee is used explicitly to keep the link non-dangling.
  function reviewerIndex(employeeIndex, slot) {
    if (employeesPerDepartment <= 1) return employeeIndex;
    const random = rng(employeeIndex, 205 + slot);
    const department = departmentIndex(employeeIndex);
    const position = employeeIndex - department * employeesPerDepartment;
    const offset = 1 + Math.floor(random() * (employeesPerDepartment - 1));
    return department * employeesPerDepartment + ((position + offset) % employeesPerDepartment);
  }

  function payrollPeriod(slot) {
    const total = 2026 * 12 + 8 - slot; // September 2026 is the most recent period.
    const year = Math.floor(total / 12);
    const month = (total % 12) + 1;
    return `${year}-${pad(month, 2)}`;
  }

  const payrollPeriodOptions = Array.from(
    { length: Math.max(1, payrollPeriods) },
    (_, slot) => payrollPeriod(slot)
  );

  const tables = [
    {
      key: 'departments',
      name: 'Departments',
      count: departmentsCount,
      fields: [
        text('Name'),
        text('Code'),
        text('CostCenter'),
        select('Location', LOCATIONS),
        number('HeadcountBudget'),
        checkbox('Active'),
        text('Notes'),
      ],
      record(index) {
        const random = rng(index, 1);
        return {
          Name: departmentName(index),
          Code: `DEP-${pad(index + 1, 3)}`,
          CostCenter: `CC-${1001 + index}`,
          Location: pick(random, LOCATIONS),
          HeadcountBudget: Math.max(1, Math.round(employeesPerDepartment * (0.8 + random() * 0.6))),
          Active: random() > 0.05,
          Notes: note(noteRng(index, 2)),
        };
      },
    },
    {
      key: 'employees',
      name: 'Employees',
      count: employeesCount,
      fields: [
        text('Name'),
        text('EmployeeNo'),
        text('Email'),
        linkField('Department', 'departments'),
        select('Title', TITLES),
        select('Level', LEVELS),
        select('EmploymentType', ['Full-time', 'Part-time', 'Contract']),
        select('Status', ['Active', 'Probation', 'OnLeave', 'Terminated']),
        dateField('HireDate'),
        number('MonthlyBaseSalary'),
        number('AnnualLeaveBalance'),
        checkbox('Remote'),
        multiSelect('Skills', SKILLS),
        text('Notes'),
      ],
      record(index, ctx) {
        const random = rng(index, 15);
        const skills = [];
        const skillCount = 1 + Math.floor(random() * 3);
        while (skills.length < skillCount) {
          const skill = pick(random, SKILLS);
          if (!skills.includes(skill)) skills.push(skill);
        }
        return {
          Name: `Employee ${pad(index + 1, 5)}`,
          EmployeeNo: `EMP-${pad(index + 1, 6)}`,
          Email: `employee${index + 1}@example.test`,
          Department: ctx.link('departments', departmentIndex(index)),
          Title: pick(random, TITLES),
          Level: `L${employeeLevel(index)}`,
          EmploymentType: pick(random, EMPLOYMENT_TYPES),
          Status: pick(random, EMPLOYEE_STATUSES),
          HireDate: date(hireOffset(index)),
          MonthlyBaseSalary: monthlyBase(index),
          AnnualLeaveBalance: annualLeaveEntitlement(index),
          Remote: random() < 0.4,
          Skills: skills,
          Notes: note(noteRng(index, 16)),
        };
      },
    },
    {
      key: 'leaveRequests',
      name: 'Leave Requests',
      count: leaveCount,
      fields: [
        text('RequestNo'),
        linkField('Employee', 'employees'),
        select('LeaveType', LEAVE_TYPES),
        dateField('StartDate'),
        dateField('EndDate'),
        number('DaysRequested'),
        select('Status', LEAVE_STATUSES),
        number('AnnualBalanceBefore'),
        number('AnnualBalanceAfter'),
        text('Notes'),
      ],
      record(index, ctx) {
        const employeeIndex = Math.floor(index / leaveGroupSize);
        const slot = index % leaveGroupSize;
        const available = availableLeave(employeeIndex, slot);
        const plan = buildLeavePlan(employeeIndex, slot, available);
        return {
          RequestNo: `LR-${pad(index + 1, 6)}`,
          Employee: ctx.link('employees', employeeIndex),
          LeaveType: plan.type,
          StartDate: date(plan.startDay),
          EndDate: date(plan.endDay),
          DaysRequested: plan.days,
          Status: plan.status,
          AnnualBalanceBefore: plan.balanceBefore,
          AnnualBalanceAfter: plan.balanceAfter,
          Notes: note(noteRng(index, 17)),
        };
      },
    },
    {
      key: 'reviews',
      name: 'Reviews',
      count: reviewCount,
      fields: [
        text('ReviewNo'),
        linkField('Employee', 'employees'),
        linkField('Reviewer', 'employees'),
        select('ReviewPeriod', REVIEW_PERIODS),
        dateField('ReviewDate'),
        number('GoalsScore'),
        number('CompetencyScore'),
        number('OverallScore'),
        select('Status', ['Submitted', 'Acknowledged', 'Draft']),
        checkbox('PromotionRecommended'),
        text('Comments'),
      ],
      record(index, ctx) {
        const employeeIndex = Math.floor(index / reviewGroupSize);
        const slot = index % reviewGroupSize;
        const random = rng(employeeIndex, 210 + slot);
        const day = reviewDay(employeeIndex, slot);
        const goalsScore = 1 + Math.floor(random() * 5);
        const competencyScore = 1 + Math.floor(random() * 5);
        const overallScore = Math.round(((goalsScore + competencyScore) / 2) * 10) / 10;
        return {
          ReviewNo: `RV-${pad(index + 1, 6)}`,
          Employee: ctx.link('employees', employeeIndex),
          Reviewer: ctx.link('employees', reviewerIndex(employeeIndex, slot)),
          ReviewPeriod: reviewPeriod(day),
          ReviewDate: date(day),
          GoalsScore: goalsScore,
          CompetencyScore: competencyScore,
          OverallScore: overallScore,
          Status: weighted(random, REVIEW_STATUSES, REVIEW_STATUS_WEIGHTS),
          PromotionRecommended: overallScore >= 4 && random() < 0.5,
          Comments: note(noteRng(index, 18)),
        };
      },
    },
    {
      key: 'payroll',
      name: 'Payroll',
      count: payrollCount,
      fields: [
        text('PayrollNo'),
        linkField('Employee', 'employees'),
        select('Period', payrollPeriodOptions),
        dateField('PayDate'),
        select('Currency', ['CNY']),
        number('GrossSalary'),
        number('Bonus'),
        number('Deductions'),
        formula('NetPay', '{GrossSalary} + {Bonus} - {Deductions}'),
        select('Status', PAYROLL_STATUSES),
        text('Notes'),
      ],
      record(index, ctx) {
        const employeeIndex = Math.floor(index / payrollGroupSize);
        const slot = index % payrollGroupSize;
        const random = rng(employeeIndex, 300 + slot);
        const gross = monthlyBase(employeeIndex);
        const bonus = money(gross * (0.05 + random() * 0.25));
        const deductions = money(gross * (0.1 + random() * 0.15));
        const payDay = Math.max(hireOffset(employeeIndex) + 30, -30 * slot + 5);
        const status = slot === 0
          ? (random() < 0.6 ? 'Pending' : 'Paid')
          : weighted(random, PAYROLL_STATUSES, PAYROLL_STATUS_WEIGHTS);
        return {
          PayrollNo: `PR-${pad(index + 1, 6)}`,
          Employee: ctx.link('employees', employeeIndex),
          Period: payrollPeriod(slot),
          PayDate: date(payDay),
          Currency: 'CNY',
          GrossSalary: gross,
          Bonus: bonus,
          Deductions: deductions,
          Status: status,
          Notes: note(noteRng(index, 19)),
        };
      },
    },
  ];

  return {
    domain: 'hr',
    description:
      'Synthetic HR workspace: departments, employees, leave requests, performance reviews and CNY payroll. '
      + 'Employee identities are employee<number>@example.test; no phone numbers, IDs or bank accounts.',
    primary: 'employees',
    distribution:
      `${departmentsCount} departments x ${employeesPerDepartment} employees; `
      + `${leavePerEmployee} leave requests and ${reviewsPerEmployee} reviews per employee, `
      + `${payrollPeriods} monthly payroll periods. `
      + 'Hire dates precede the earliest payroll period and every leave/review/payday is after hire. '
      + 'Leave days are 1-7 and annual leave reduces the employee balance; scores are bounded 1-5. '
      + 'Reviewers are same-department peers and never the reviewee, except when a department has one '
      + 'employee, where that employee is the explicit self-review fallback. '
      + 'Payroll is entirely CNY with bonus 5-30% and deductions 10-25%; notes are roughly 10% empty.',
    workloads: [
      {
        table: 'employees',
        field: 'Notes',
        description: 'Edit an employee note during onboarding or after a status change.',
      },
      {
        table: 'leaveRequests',
        field: 'Notes',
        description: 'Append a reviewer comment to a leave request and save the record.',
      },
      {
        table: 'reviews',
        field: 'Comments',
        description: 'Revise reviewer feedback on a submitted performance review.',
      },
    ],
    tables,
  };
}
