const { backportPullRequest } = require("github-backport");
const { execSync } = require("child_process");
const fs = require('fs');

const reviewChecklist = `### Review Checklist
            
Hello reviewers! :wave: Please follow this checklist when reviewing this Pull Request.

#### General
- [ ] Ensure that the Pull Request has a descriptive title.
- [ ] If this is a change that users need to know about, please apply the \`release notes (needs details)\` label so that merging is blocked unless the summary release notes document is included.
- [ ] If a new flag is being introduced, review whether it is really needed. The flag names should be clear and intuitive (as far as possible), and the flag's help should be descriptive. Additionally, flag names should use dashes (\`-\`) as word separators rather than underscores (\`_\`).
- [ ] If a workflow is added or modified, each items in \`Jobs\` should be named in order to mark it as \`required\`. If the workflow should be required, the GitHub Admin should be notified.

#### Bug fixes
- [ ] There should be at least one unit or end-to-end test.
- [ ] The Pull Request description should either include a link to an issue that describes the bug OR an actual description of the bug and how to reproduce, along with a description of the fix.

#### Non-trivial changes
- [ ] There should be some code comments as to why things are implemented the way they are.

#### New/Existing features
- [ ] Should be documented, either by modifying the existing documentation or creating new documentation.
- [ ] New features should have a link to a feature request issue or an RFC that documents the use cases, corner cases and test cases.

#### Backward compatibility            
- [ ] Protobuf changes should be wire-compatible.
- [ ] Changes to \`_vt\` tables and RPCs need to be backward compatible.
- [ ] \`vtctl\` command output order should be stable and \`awk\`-able.
`

const backportLabelPrefix = "Backport to: "
const forwardportLabelPrefix = "Forwardport to: "

async function portPR(context, pr, pr_details, branches, labels, type) {
  var failedBranches = [];

  // Loop over the given branch and port the PR to them.
  for (const branch of branches) {
    var portedPullRequestNumber = 0;
    try {
      portedPullRequestNumber = await backportPullRequest({
        base: branch,
        title: "[" + branch + "] " + pr_details.data.title + " (#" + pr.pull_number + ")",
        body: `## Description
This is a ` + type + ` of #` + pr.pull_number + `.
`,
        head: type + "-" + pr.pull_number + "-to-" + branch,
        octokit: context.octokit,
        owner: pr.owner,
        pullRequestNumber: pr.pull_number,
        repo: pr.repo,
      });
    } catch (error) {
      failedBranches.push(branch);
      continue
    }
    await context.octokit.rest.issues.addLabels({
      owner: pr.owner,
      repo: pr.repo,
      issue_number: portedPullRequestNumber,
      labels: labels,
    });
  }

  // If we had a failure, let's comment the PR with the list of branches where the backport/forwardport failed.
  if (failedBranches.length > 0) {
    await context.octokit.issues.createComment({
      owner: pr.owner,
      repo: pr.repo,
      issue_number: pr.pull_number,
      body: "I was unable to " + type + " this Pull Request to the following branches: `" + failedBranches.join("`, `") + "`.",
    });
  }
}

module.exports = (app) => {

  app.on(["pull_request.opened", "pull_request.labeled", "pull_request.unlabeled", "pull_request.synchronize"], async (context) => {
    const pr = context.pullRequest();


    if (pr.pull_number != 10738) {
      return;
    }

    const per_page = 100;
    let cont = true;
    let files = []
    for (let page = 1; cont; page++) {
      let currentFiles = await context.octokit.rest.pulls.listFiles({
        owner: pr.owner,
        repo: pr.repo,
        pull_number: pr.pull_number,
        per_page: per_page,
        page: page,
      });
      if (currentFiles.data.length < per_page) {
        cont = false;
      }
      files = files.concat(currentFiles.data)
    }

    let found = false;
    for (let index = 0; index < files.length && found == false; index++) {
      const file = files[index];
      if (file.filename == "go/vt/vterrors/code.go") {
        found = true;
      }
    }
    if (found == false) {
      return
    }
    execSync("git clone https://github.com/vitessio/vitess /tmp/vitess || true");
    execSync("cd /tmp/vitess && git fetch origin refs/pull/" + pr.pull_number + "/head && git checkout FETCH_HEAD");
    let output = execSync("cd /tmp/vitess && go run ./go/vt/vterrors/main/");
    let errStrVitess = output.toString()

    execSync("git clone https://github.com/vitessio/website /tmp/website || true");
    execSync("cd /tmp/website && git fetch origin refs/pull/1100/head && git checkout FETCH_HEAD");
    output = execSync("cd /tmp/website && git fetch && cat /tmp/website/content/en/docs/15.0/reference/errors/query-serving.md");
    let errStrWebsite = output.toString()

    const prefixLabel = "<!-- start -->"
    const suffixLabel = "<!-- end -->"
    let startIdx = errStrWebsite.indexOf(prefixLabel)
    let endIdx = errStrWebsite.indexOf(suffixLabel)
    let prefix = errStrWebsite.substring(0, startIdx + prefixLabel.length)
    let suffix = errStrWebsite.substring(endIdx, errStrWebsite.length)

    let str = prefix + '\n' + errStrVitess + suffix

    fs.writeFileSync('/tmp/website/content/en/docs/15.0/reference/errors/query-serving.md', str);
    output = execSync("cd /tmp/website && git status -s");
    if (output.toString().length == 0) {
      return
    }

    let prodBranch = await context.octokit.rest.repos.getBranch({
      owner: pr.owner,
      repo: "website",
      branch: "prod",
    });
    console.log(prodBranch)

    let createRef = await context.octokit.rest.git.createRef({
      owner: pr.owner,
      repo: "website",
      ref: "refs/heads/update-error-code-" + pr.pull_number,
      sha: prodBranch.data.commit.sha,
    });
    console.log(createRef)
    console.log(prodBranch.data.commit.commit.tree.sha)

    let createTree = await context.octokit.rest.git.createTree({
      owner: pr.owner,
      repo: "website",
      tree: [{
        path: 'content/en/docs/15.0/reference/errors/query-serving.md',
        mode: '100644',
        type: 'blob',
        content: str,
        base_tree: prodBranch.data.commit.commit.tree.sha,
      }],
    });
    console.log(createTree)

    let createCommit = await context.octokit.rest.git.createCommit({
      owner: pr.owner,
      repo: "website",
      message: "Updated the query-serving error code",
      tree: createTree.data.sha,
      author: {
        name: 'vitess-bot[bot]',
        email: '108069721+vitess-bot[bot]@users.noreply.github.com',
      },
      parents: [
        prodBranch.data.commit.sha
      ],
    })
    console.log(createCommit)
  });

  app.on(["pull_request.opened", "pull_request.ready_for_review", "pull_request.reopened"], async (context) => {
    const pr = context.pullRequest();

    // We only comment when the repository if vitessio/vitess
    if (pr.owner != 'vitessio' && pr.repo != 'vitess') {
      return
    }

    let comments = await context.octokit.rest.issues.listComments({
      owner: pr.owner,
      repo: pr.repo,
      issue_number: pr.pull_number,
    });

    var comment = { owner: pr.owner, repo: pr.repo, body: reviewChecklist };

    for (let index = 0; index < comments.data.length; index++) {
      const element = comments.data[index];
      if (element.user.login == "vitess-bot[bot]" && element.body.includes("### Review Checklist")) {
        comment.comment_id = element.id;
        return context.octokit.issues.updateComment(comment);
      }
    }

    comment.issue_number = pr.pull_number;
    return context.octokit.issues.createComment(comment);
  });

  app.on(["pull_request.closed"], async (context) => {
    if (context.payload.merged == false) {
      return
    }

    const pr = context.pullRequest();

    const pr_details = await context.octokit.rest.pulls.get({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.pull_number,
    });

    // Get the list of branches on which we need to port the PR.
    var backportBranches = []; // Contains all the branches to backport-to.
    var forwardportBranches = []; // Contains all the branches to forwardport-to.
    var labelsForPortPR = []; // The "Backport" and "Forwardport" labels are automatically added to the list depending on the backport type.
    var labels = pr_details.data.labels;
    await labels.forEach(element => {
      var elems = []
      var type = { backport: false, forwardport: false }
      if (element.name.startsWith(backportLabelPrefix) == true) {
        elems = element.name.split(backportLabelPrefix)
        type.backport = true // This is a backport.
      } else if (element.name.startsWith(forwardportLabelPrefix) == true) {
        elems = element.name.split(forwardportLabelPrefix)
        type.forwardport = true // This is a forwardport.
      }

      if (elems.length == 0) {
        // Copy all the other labels so we can assign them to the ported PR.
        labelsForPortPR.push(element.name);
      } else if (elems.length != 2) {
        console.error("Could not analyze the label:", element.name)
      } else {
        // elems[1] is the second part of the split, which contains the branch name.
        if (type.backport == true) {
          backportBranches.push(elems[1]);
        } else if (type.forwardport == true) {
          forwardportBranches.push(elems[1]);
        }
      }
    });

    // Backport if any.
    if (backportBranches.length > 0) {
      var labels = ["Backport"]
      await portPR(context, pr, pr_details, backportBranches, labels.concat(labelsForPortPR), "backport")
    }

    // Forwardport if any.
    if (forwardportBranches.length > 0) {
      var labels = ["Forwardport"]
      await portPR(context, pr, pr_details, forwardportBranches, labels.concat(labelsForPortPR), "forwardport")
    }
    return
  });
};
