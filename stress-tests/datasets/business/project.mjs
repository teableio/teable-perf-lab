// Project management business profile: Teams -> Members -> Projects -> Tasks -> TimeEntries.
// All references are derived from record indexes, so the dataset is deterministic and has no dangling links.

const TEAM_NAMES = [
  'Platform Engineering',
  'Product Design',
  'Data & Analytics',
  'Growth Marketing',
  'Customer Success',
  'Mobile Apps',
  'Infrastructure',
  'Quality Assurance',
  'Finance Systems',
  'People Operations',
];

const DEPARTMENTS = ['Engineering', 'Product', 'Design', 'Data', 'Marketing', 'Operations', 'Finance', 'QA'];
const LOCATIONS = ['Beijing', 'Shanghai', 'Shenzhen', 'Singapore', 'Remote'];
const MEMBER_FIRST = [
  'Ava', 'Liam', 'Mia', 'Noah', 'Elena', 'Chen', 'Wei', 'Yuki', 'Priya', 'Omar',
  'Sofia', 'Diego', 'Nina', 'Kai', 'Zara', 'Hana', 'Ivan', 'Lucia',
];
const MEMBER_LAST = [
  'Chen', 'Wang', 'Li', 'Zhang', 'Smith', 'Johnson', 'Garcia', 'Miller',
  'Kim', 'Patel', 'Nguyen', 'Rossi', 'Dubois', 'Tanaka', 'Muller', 'Silva',
];
const CHINESE_NAMES = ['陈晓', '王磊', '李娜', '张伟', '刘洋', '赵敏', '周杰', '吴婷', '孙浩', '郑爽'];
const MEMBER_ROLES = ['Developer', 'Designer', 'QA', 'ProductManager', 'Manager', 'DataAnalyst'];
const MEMBER_ROLE_WEIGHTS = [5, 2, 2, 2, 1, 2];
const SENIORITY = ['Junior', 'Mid', 'Senior', 'Staff'];
const SENIORITY_WEIGHTS = [2, 4, 3, 1];

const PROJECT_PREFIXES = [
  'Atlas', 'Orion', 'Nova', 'Pulse', 'Vertex', 'Harbor',
  'Lumen', 'Cedar', 'Quartz', 'Falcon', 'Aurora', 'Beacon',
];
const PROJECT_SUFFIXES = [
  'Platform Upgrade', 'Mobile Revamp', 'Data Migration', 'Checkout Redesign',
  'Observability Suite', 'Billing Revamp', 'Onboarding Flow', 'Reporting Hub',
  'Search Overhaul', 'Partner Portal',
];
const PROJECT_STATUSES = ['Planning', 'Active', 'OnHold', 'Completed', 'Cancelled'];
const PROJECT_STATUS_WEIGHTS = [1, 5, 1, 2, 1];

const TASK_VERBS = [
  'Implement', 'Review', 'Design', 'Migrate', 'Optimize',
  'Document', 'Test', 'Refactor', 'Deploy', 'Troubleshoot',
];
const TASK_OBJECTS = [
  'API gateway', 'billing webhook', 'dashboard filters', 'login flow', 'data pipeline',
  'mobile navigation', 'permission model', 'search index', 'notification service', 'audit log',
  'export job', 'tenant onboarding',
];
const TASK_STATUSES = ['Backlog', 'Todo', 'InProgress', 'InReview', 'Done', 'Blocked'];
const TASK_STATUS_WEIGHTS = [1, 3, 4, 2, 5, 1];
const TASK_PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
const TASK_PRIORITY_WEIGHTS = [2, 5, 3, 1];
const TASK_TAGS = ['backend', 'frontend', 'design', 'qa', 'infra', 'security', 'performance', 'docs', 'mobile', 'data'];

function weighted(random, values, weights) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = random() * total;
  for (let i = 0; i < values.length; i++) {
    roll -= weights[i];
    if (roll < 0) return values[i];
  }
  return values[values.length - 1];
}

function roundHalf(value) {
  return Math.round(value * 2) / 2;
}

export default function createProfile(options, helpers) {
  const {
    count, rng, pick, money, date, note,
    text, number, dateField, select, multiSelect, checkbox, linkField, formula,
  } = helpers;

  const teamsCount = count('teams', 10, { scaled: true });
  const membersPerTeam = count('members-per-team', 8);
  const projectsPerTeam = count('projects-per-team', 5);
  const tasksPerProject = count('tasks-per-project', 40);
  const entriesPerTask = count('entries-per-task', 2, { min: 0 });

  const membersCount = teamsCount * membersPerTeam;
  const projectsCount = teamsCount * projectsPerTeam;
  const tasksCount = projectsCount * tasksPerProject;
  const entriesCount = tasksCount * entriesPerTask;

  const memberTeam = (memberIndex) => Math.floor(memberIndex / membersPerTeam);
  const projectTeam = (projectIndex) => Math.floor(projectIndex / projectsPerTeam);

  // A project spans a fixed window, shared by its tasks and their time entries.
  function projectWindow(projectIndex) {
    const random = rng(projectIndex, 601);
    const team = projectTeam(projectIndex);
    const withinTeam = projectIndex % projectsPerTeam;
    const startDay = team * 20 + withinTeam * 40 + Math.floor(random() * 10);
    const duration = 90 + Math.floor(random() * 60);
    return { startDay, endDay: startDay + duration };
  }

  // Tasks are spread across the project window and always fit inside it.
  function taskWindow(taskIndex) {
    const projectIndex = Math.floor(taskIndex / tasksPerProject);
    const withinProject = taskIndex % tasksPerProject;
    const random = rng(taskIndex, 701);
    const { startDay: projectStart, endDay: projectEnd } = projectWindow(projectIndex);
    const span = projectEnd - projectStart;
    const offset = Math.floor(((span - 10) * withinProject) / tasksPerProject) + Math.floor(random() * 3);
    const startDay = projectStart + offset;
    const dueDay = Math.min(projectEnd, startDay + 3 + Math.floor(random() * 15));
    return { projectIndex, startDay, dueDay };
  }

  function taskOwnerOffset(taskIndex) {
    const random = rng(taskIndex, 503);
    return Math.floor(random() * membersPerTeam) % membersPerTeam;
  }

  function teamName(teamIndex) {
    const base = TEAM_NAMES[teamIndex % TEAM_NAMES.length];
    const cycle = Math.floor(teamIndex / TEAM_NAMES.length);
    return cycle === 0 ? base : `${base} ${cycle + 1}`;
  }

  function memberName(memberIndex) {
    if (memberIndex % 3 === 0) {
      return CHINESE_NAMES[memberIndex % CHINESE_NAMES.length];
    }
    const first = MEMBER_FIRST[memberIndex % MEMBER_FIRST.length];
    const last = MEMBER_LAST[Math.floor(memberIndex / MEMBER_FIRST.length) % MEMBER_LAST.length];
    return `${first} ${last}`;
  }

  function projectName(projectIndex) {
    const prefix = PROJECT_PREFIXES[projectIndex % PROJECT_PREFIXES.length];
    const suffix = PROJECT_SUFFIXES[Math.floor(projectIndex / PROJECT_PREFIXES.length) % PROJECT_SUFFIXES.length];
    const cycle = Math.floor(projectIndex / (PROJECT_PREFIXES.length * PROJECT_SUFFIXES.length));
    return cycle === 0 ? `${prefix} ${suffix}` : `${prefix} ${suffix} ${cycle + 1}`;
  }

  function taskTitle(taskIndex) {
    const verb = TASK_VERBS[taskIndex % TASK_VERBS.length];
    const object = TASK_OBJECTS[Math.floor(taskIndex / TASK_VERBS.length) % TASK_OBJECTS.length];
    return `${verb} ${object} (T-${String(taskIndex + 1).padStart(4, '0')})`;
  }

  const tables = [
    {
      key: 'teams',
      name: 'Teams',
      count: teamsCount,
      fields: [
        text('Name'),
        select('Department', DEPARTMENTS),
        select('Location', LOCATIONS),
        checkbox('Active'),
        text('Notes'),
      ],
      record(index) {
        const random = rng(index, 11);
        return {
          Name: teamName(index),
          Department: pick(random, DEPARTMENTS),
          Location: pick(random, LOCATIONS),
          Active: random() > 0.1,
          Notes: note(rng(index, 12)),
        };
      },
    },
    {
      key: 'members',
      name: 'Members',
      count: membersCount,
      fields: [
        text('Name'),
        text('Email'),
        select('Role', MEMBER_ROLES),
        select('Seniority', SENIORITY),
        linkField('Team', 'teams'),
        number('WeeklyCapacity'),
        checkbox('Active'),
        text('Notes'),
      ],
      record(index, ctx) {
        const random = rng(index, 21);
        return {
          Name: memberName(index),
          Email: `member${index + 1}@example.com`,
          Role: weighted(random, MEMBER_ROLES, MEMBER_ROLE_WEIGHTS),
          Seniority: weighted(random, SENIORITY, SENIORITY_WEIGHTS),
          Team: ctx.link('teams', memberTeam(index)),
          WeeklyCapacity: 20 + Math.floor(random() * 21),
          Active: random() > 0.08,
          Notes: note(rng(index, 22)),
        };
      },
    },
    {
      key: 'projects',
      name: 'Projects',
      count: projectsCount,
      fields: [
        text('Name'),
        text('Code'),
        linkField('Team', 'teams'),
        linkField('Owner', 'members'),
        select('Status', PROJECT_STATUSES),
        dateField('StartDate'),
        dateField('EndDate'),
        number('Budget'),
        text('Notes'),
      ],
      record(index, ctx) {
        const random = rng(index, 31);
        const team = projectTeam(index);
        const owner = team * membersPerTeam + Math.floor(random() * membersPerTeam);
        const { startDay, endDay } = projectWindow(index);
        return {
          Name: projectName(index),
          Code: `PRJ-${String(index + 1).padStart(4, '0')}`,
          Team: ctx.link('teams', team),
          Owner: ctx.link('members', owner),
          Status: weighted(random, PROJECT_STATUSES, PROJECT_STATUS_WEIGHTS),
          StartDate: date(startDay),
          EndDate: date(endDay),
          Budget: money(50000 + random() * 450000),
          Notes: note(rng(index, 32)),
        };
      },
    },
    {
      key: 'tasks',
      name: 'Tasks',
      count: tasksCount,
      fields: [
        text('Title'),
        linkField('Project', 'projects'),
        linkField('Owner', 'members'),
        linkField('Reviewers', 'members', { many: true }),
        select('Status', TASK_STATUSES),
        select('Priority', TASK_PRIORITIES),
        multiSelect('Tags', TASK_TAGS),
        dateField('StartDate'),
        dateField('DueDate'),
        checkbox('Completed'),
        dateField('CompletedDate'),
        number('Progress'),
        number('EstimatedHours'),
        number('LoggedHours'),
        formula('RemainingHours', '{EstimatedHours} - {LoggedHours}'),
        text('Notes'),
      ],
      record(index, ctx) {
        const random = rng(index, 41);
        const projectIndex = Math.floor(index / tasksPerProject);
        const team = projectTeam(projectIndex);
        const teamBase = team * membersPerTeam;
        const ownerOffset = taskOwnerOffset(index);
        const { startDay, dueDay } = taskWindow(index);
        const status = weighted(random, TASK_STATUSES, TASK_STATUS_WEIGHTS);
        const completed = status === 'Done';
        const wantsReviewers = random() >= 0.4;
        const reviewerSlots = wantsReviewers ? 1 + Math.floor(random() * 2) : 0;
        const availableOffsets = [];
        for (let offset = 0; offset < membersPerTeam; offset++) {
          if (offset !== ownerOffset) availableOffsets.push(offset);
        }
        const reviewerOffsets = [];
        while (reviewerOffsets.length < reviewerSlots && availableOffsets.length > 0) {
          reviewerOffsets.push(availableOffsets.splice(Math.floor(random() * availableOffsets.length), 1)[0]);
        }

        const estimatedHours = roundHalf(4 + random() * 36);
        const loggedHours = completed
          ? estimatedHours
          : Math.min(estimatedHours, roundHalf(estimatedHours * (0.05 + random() * 0.7)));
        const progress = completed
          ? 100
          : status === 'InReview'
            ? 75 + Math.floor(random() * 21)
            : status === 'InProgress'
              ? 15 + Math.floor(random() * 56)
              : status === 'Blocked'
                ? 10 + Math.floor(random() * 41)
                : 0;
        const completionDay = startDay + Math.floor(random() * (dueDay - startDay + 1));
        const tagCount = Math.floor(random() * 4);
        const tagPool = TASK_TAGS.slice();
        const tags = [];
        for (let i = 0; i < tagCount; i++) {
          tags.push(tagPool.splice(Math.floor(random() * tagPool.length), 1)[0]);
        }

        return {
          Title: taskTitle(index),
          Project: ctx.link('projects', projectIndex),
          Owner: ctx.link('members', teamBase + ownerOffset),
          Reviewers: reviewerOffsets.map((offset) => ctx.link('members', teamBase + offset)),
          Status: status,
          Priority: weighted(random, TASK_PRIORITIES, TASK_PRIORITY_WEIGHTS),
          Tags: tags,
          StartDate: date(startDay),
          DueDate: date(dueDay),
          Completed: completed,
          CompletedDate: completed ? date(completionDay) : null,
          Progress: progress,
          EstimatedHours: estimatedHours,
          LoggedHours: loggedHours,
          Notes: note(rng(index, 42)),
        };
      },
    },
    {
      key: 'timeEntries',
      name: 'Time Entries',
      count: entriesCount,
      fields: [
        linkField('Task', 'tasks'),
        linkField('Member', 'members'),
        dateField('WorkDate'),
        number('Hours'),
        number('HourlyRate'),
        checkbox('Billable'),
        formula('BillableAmount', '{Hours} * {HourlyRate}'),
        text('Notes'),
      ],
      record(index, ctx) {
        const random = rng(index, 51);
        const taskIndex = Math.floor(index / entriesPerTask);
        const { projectIndex, startDay, dueDay } = taskWindow(taskIndex);
        const teamBase = projectTeam(projectIndex) * membersPerTeam;
        const ownerOffset = taskOwnerOffset(taskIndex);
        const memberOffset = random() < 0.65
          ? ownerOffset
          : Math.floor(random() * membersPerTeam);
        const workDay = startDay + Math.floor(random() * (dueDay - startDay + 1));
        return {
          Task: ctx.link('tasks', taskIndex),
          Member: ctx.link('members', teamBase + memberOffset),
          WorkDate: date(workDay),
          Hours: roundHalf(0.5 + random() * 7.5),
          HourlyRate: money(300 + random() * 700),
          Billable: random() > 0.15,
          Notes: note(rng(index, 52)),
        };
      },
    },
  ];

  return {
    domain: 'project',
    description: 'Project delivery workspace with teams, members, projects, tasks and logged time entries.',
    primary: 'tasks',
    distribution:
      'Tasks are weighted across statuses (Done ~31%, InProgress ~25%) and priorities (Medium ~45%); '
      + 'about 60% of tasks carry reviewers; completed tasks have Completed=true and a CompletedDate; '
      + 'notes are roughly 10% empty.',
    workloads: [
      {
        table: 'tasks',
        field: 'Title',
        description: 'Inline-rename a task title, then re-sort the task grid by priority.',
      },
      {
        table: 'tasks',
        field: 'Notes',
        description: 'Append a progress note to a task and save the record.',
      },
      {
        table: 'timeEntries',
        field: 'Notes',
        description: 'Log a work note on a time entry.',
      },
      {
        table: 'projects',
        field: 'Name',
        description: 'Rename a project and refilter the projects grid.',
      },
    ],
    tables,
  };
}
